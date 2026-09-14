import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CandidateAction,
  DecisionObject,
  DecisionOutcome,
  ExecutionPlan,
  ExplanationRecord,
  RiskAssessment,
} from '@skytwin/shared-types';
import { ConfidenceLevel, SituationType, TrustTier } from '@skytwin/shared-types';
import { PolicyEvaluator, type PolicyDecision } from '@skytwin/policy-engine';
import { RiskAssessor } from '@skytwin/decision-engine';
import {
  policyRepositoryAdapter,
  routineNonActionRepository,
  userRepository,
} from '@skytwin/db';
import { getIronClawEnhancedAdapter } from '../execution-setup.js';
import { readAutonomy } from '../cost-gate.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';

// Cron expression: 5 or 6 space-separated fields, each containing digits, *, /, -, or ,
const CRON_REGEX = /^[0-9*/,-]+( [0-9*/,-]+){4,5}$/;
const MAX_CRON_LENGTH = 128;
const MAX_ROUTINE_ID_LENGTH = 256;
const MAX_ACTION_TYPE_LENGTH = 128;

// If routine registration is re-enabled after per-run admission exists, it may
// only schedule a known free + reversible action type. Cost, reversibility,
// and provenance are classified here rather than accepted from request data.
const FREE_ROUTINE_ACTION_TYPES = new Set<string>([
  'create_note',
  'create_document',
  'set_reminder',
  'snooze_reminder',
  'label_email',
  'archive_email',
  'acknowledge',
  'dismiss',
]);

const REGISTRATION_UNAVAILABLE: PolicyDecision = {
  allowed: false,
  requiresApproval: false,
  reason:
    'Unattended routines are disabled until every scheduled run has runtime policy and explanation admission.',
};

const DELETION_UNAVAILABLE: PolicyDecision = {
  allowed: false,
  requiresApproval: false,
  reason: 'Routine deletion is disabled until the remote operation has durable admission and reconciliation.',
};

type RoutineDisposition = 'blocked' | 'requires-approval';

interface RoutineArtifacts {
  decision: DecisionObject;
  action: CandidateAction;
  risk: RiskAssessment;
}

export function createRoutinesRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);
  const policyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);

  router.post('/', async (req, res, next) => {
    try {
      const { userId, schedule, plan } = req.body as {
        userId?: string;
        schedule?: string;
        plan?: ExecutionPlan;
      };

      if (!userId || !schedule || !plan) {
        res.status(400).json({ error: 'Missing required fields: userId, schedule, plan' });
        return;
      }

      if (schedule.length > MAX_CRON_LENGTH || !CRON_REGEX.test(schedule)) {
        res.status(400).json({
          error: 'Invalid schedule format. Expected a cron expression (e.g., "0 9 * * *").',
        });
        return;
      }

      const actionType = normalizeActionType(plan.action?.actionType);
      if (!plan.action || actionType === null) {
        res.status(400).json({ error: 'Plan must include an action with an actionType.' });
        return;
      }

      const user = await userRepository.findById(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      const artifacts = buildRegistrationArtifacts(
        userId,
        schedule,
        plan.action,
        actionType,
        routineRegistrationIdempotencyKey(req.get('idempotency-key'), schedule, actionType, plan.action),
      );
      const policies = await policyRepositoryAdapter.getAllPolicies();
      const policy = await policyEvaluator.evaluate(
        artifacts.action,
        policies,
        (user.trust_tier as TrustTier) ?? TrustTier.OBSERVER,
        artifacts.risk,
        readAutonomy(user),
      );
      const effectivePolicy = policy.allowed && !policy.requiresApproval
        ? REGISTRATION_UNAVAILABLE
        : policy;
      const disposition: RoutineDisposition = effectivePolicy.requiresApproval
        ? 'requires-approval'
        : 'blocked';

      const created = await persistRoutineNonAction(
        artifacts,
        buildRoutineOutcome(artifacts, effectivePolicy, disposition),
        buildRegistrationExplanation(userId, schedule, artifacts, effectivePolicy, disposition),
      );
      if (!created) {
        res.status(409).json({
          error: 'A matching routine registration is already recorded and will not be replayed automatically.',
          code: 'routine_write_already_recorded',
        });
        return;
      }

      if (!policy.allowed) {
        res.status(403).json({
          error: 'Routine blocked by policy.',
          code: 'routine_blocked_by_policy',
          reason: policy.reason,
        });
        return;
      }
      if (policy.requiresApproval) {
        res.status(403).json({
          error: 'Routine blocked: this action requires manual approval and cannot run unattended on a schedule.',
          code: 'routine_requires_approval',
          reason: policy.reason,
        });
        return;
      }

      res.status(503).json({
        error: 'Unattended routine registration is not available in this release.',
        code: 'routine_registration_unavailable',
        reason: REGISTRATION_UNAVAILABLE.reason,
      });
    } catch (error) {
      next(error);
    }
  });

  // Listing is read-only and remains available. The write routes below never
  // resolve the remote adapter while their durable admission path is absent.
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const adapter = await getIronClawEnhancedAdapter();
      if (!adapter) {
        res.json({ userId, routines: [], available: false });
        return;
      }

      const routines = await adapter.listRoutines(userId);
      res.json({ userId, routines, available: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:routineId', async (req, res, next) => {
    try {
      const { routineId } = req.params;
      if (
        !routineId ||
        routineId.length > MAX_ROUTINE_ID_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(routineId)
      ) {
        res.status(400).json({ error: 'Invalid routine id.' });
        return;
      }

      const bodyUserId = (req.body as Record<string, unknown>)?.['userId'];
      const queryUserId = req.query['userId'];
      const suppliedUserId = typeof bodyUserId === 'string'
        ? bodyUserId
        : typeof queryUserId === 'string'
          ? queryUserId
          : undefined;
      const authenticatedUserId = req.authenticatedUserId;
      if (
        typeof authenticatedUserId === 'string' &&
        suppliedUserId !== undefined &&
        suppliedUserId !== authenticatedUserId
      ) {
        res.status(403).json({ error: 'Routine owner does not match the authenticated user.' });
        return;
      }
      const userId = authenticatedUserId ?? suppliedUserId;
      if (!userId) {
        res.status(400).json({ error: 'Missing required userId' });
        return;
      }

      const user = await userRepository.findById(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      const artifacts = buildDeletionArtifacts(userId, routineId);
      const policies = await policyRepositoryAdapter.getAllPolicies();
      const policy = await policyEvaluator.evaluate(
        artifacts.action,
        policies,
        (user.trust_tier as TrustTier) ?? TrustTier.OBSERVER,
        artifacts.risk,
        readAutonomy(user),
      );
      const effectivePolicy = policy.allowed && !policy.requiresApproval
        ? DELETION_UNAVAILABLE
        : policy;
      const disposition: RoutineDisposition = effectivePolicy.requiresApproval
        ? 'requires-approval'
        : 'blocked';
      const created = await persistRoutineNonAction(
        artifacts,
        buildRoutineOutcome(artifacts, effectivePolicy, disposition),
        buildDeletionExplanation(userId, routineId, artifacts, effectivePolicy, disposition),
      );
      if (!created) {
        res.status(409).json({
          error: 'A matching routine deletion is already recorded and will not be replayed automatically.',
          code: 'routine_write_already_recorded',
        });
        return;
      }

      if (!policy.allowed || policy.requiresApproval) {
        res.status(403).json({
          error: policy.requiresApproval
            ? 'Routine deletion requires manual approval and was not dispatched.'
            : 'Routine deletion was blocked by policy.',
          code: policy.requiresApproval
            ? 'routine_requires_approval'
            : 'routine_blocked_by_policy',
          reason: policy.reason,
        });
        return;
      }

      res.status(503).json({
        routineId,
        deleted: false,
        error: 'Routine deletion is not available in this release; nothing was dispatched.',
        code: 'routine_deletion_unavailable',
        reason: DELETION_UNAVAILABLE.reason,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function persistRoutineNonAction(
  artifacts: RoutineArtifacts,
  outcome: DecisionOutcome,
  explanation: ExplanationRecord,
): Promise<boolean> {
  const result = await routineNonActionRepository.record({
    decision: artifacts.decision,
    action: artifacts.action,
    risk: artifacts.risk,
    outcome,
    explanation,
  });
  return result.created;
}

function buildRegistrationArtifacts(
  userId: string,
  schedule: string,
  rawAction: ExecutionPlan['action'],
  actionType: string,
  idempotencyKey: string,
): RoutineArtifacts {
  const decisionId = randomUUID();
  const knownSafe = FREE_ROUTINE_ACTION_TYPES.has(actionType);
  const action: CandidateAction = {
    id: randomUUID(),
    decisionId,
    actionType,
    description: typeof rawAction.description === 'string' ? rawAction.description : '',
    domain: typeof rawAction.domain === 'string' ? rawAction.domain : 'general',
    parameters: rawAction.parameters && typeof rawAction.parameters === 'object'
      ? { ...rawAction.parameters, userId }
      : { userId },
    estimatedCostCents: 0,
    costZeroIntent: knownSafe ? 'verified_zero' : 'unknown',
    reversible: knownSafe,
    confidence: ConfidenceLevel.LOW,
    reasoning: typeof rawAction.reasoning === 'string'
      ? rawAction.reasoning
      : 'Scheduled routine action',
    provenance: 'untrusted_external',
  };
  const decision: DecisionObject = {
    id: decisionId,
    situationType: SituationType.GENERIC,
    domain: action.domain,
    urgency: 'medium',
    summary: `Evaluate scheduled ${action.actionType} routine (${schedule}).`,
    rawData: {
      userId,
      signalId: `routine-registration:${idempotencyKey}`,
      schedule,
      normalizedAction: serializeCandidate(action),
    },
    interpretedAt: new Date(),
    provenance: 'user_originated',
  };
  return { decision, action, risk: new RiskAssessor().assess(action) };
}

function buildDeletionArtifacts(userId: string, routineId: string): RoutineArtifacts {
  const decisionId = randomUUID();
  const action: CandidateAction = {
    id: randomUUID(),
    decisionId,
    actionType: 'delete_routine',
    description: 'Delete one exact scheduled routine.',
    domain: 'routines',
    parameters: { userId, routineId },
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero',
    // The current remote API cannot restore the exact schedule and provider
    // identity, so deletion is conservatively irreversible.
    reversible: false,
    confidence: ConfidenceLevel.CONFIRMED,
    reasoning: 'The user directly requested deletion of this exact routine identifier.',
    provenance: 'user_originated',
  };
  const idempotencyKey = createHash('sha256')
    .update(`${userId}\u0000${routineId}`)
    .digest('hex');
  const decision: DecisionObject = {
    id: decisionId,
    situationType: SituationType.GENERIC,
    domain: action.domain,
    urgency: 'high',
    summary: `Evaluate deletion of routine ${routineId}.`,
    rawData: {
      userId,
      signalId: `routine-deletion:${idempotencyKey}`,
      routineId,
    },
    interpretedAt: new Date(),
    provenance: 'user_originated',
  };
  return { decision, action, risk: new RiskAssessor().assess(action) };
}

function buildRoutineOutcome(
  artifacts: RoutineArtifacts,
  policy: PolicyDecision,
  disposition: RoutineDisposition,
): DecisionOutcome {
  return {
    id: randomUUID(),
    decisionId: artifacts.decision.id,
    selectedAction: null,
    allCandidates: [artifacts.action],
    riskAssessment: null,
    allRiskAssessments: [artifacts.risk],
    autoExecute: false,
    requiresApproval: disposition === 'requires-approval',
    reasoning: policy.reason,
    decidedAt: new Date(),
    policyVerdicts: {
      [artifacts.action.id]: disposition === 'requires-approval' ? 'requires-approval' : 'denied',
    },
    confirmationLevel: policy.confirmationLevel,
  };
}

function buildRegistrationExplanation(
  userId: string,
  schedule: string,
  artifacts: RoutineArtifacts,
  policy: PolicyDecision,
  disposition: RoutineDisposition,
): ExplanationRecord {
  return buildExplanation(
    userId,
    artifacts,
    policy,
    disposition,
    disposition === 'requires-approval'
      ? 'The routine was not registered because it requires human approval.'
      : 'The routine was not registered.',
    `Normalized ${artifacts.action.actionType} action scheduled for ${schedule}.`,
    'This is the exact server-normalized action evaluated before registration availability was decided.',
  );
}

function buildDeletionExplanation(
  userId: string,
  routineId: string,
  artifacts: RoutineArtifacts,
  policy: PolicyDecision,
  disposition: RoutineDisposition,
): ExplanationRecord {
  return buildExplanation(
    userId,
    artifacts,
    policy,
    disposition,
    disposition === 'requires-approval'
      ? 'The routine was not deleted because it requires human approval.'
      : 'The routine was not deleted.',
    `Request for exact routine identifier ${routineId}.`,
    'This is the exact routine identifier evaluated before deletion availability was decided.',
  );
}

function buildExplanation(
  userId: string,
  artifacts: RoutineArtifacts,
  policy: PolicyDecision,
  disposition: RoutineDisposition,
  summary: string,
  evidenceSummary: string,
  relevance: string,
): ExplanationRecord {
  return {
    id: randomUUID(),
    decisionId: artifacts.decision.id,
    userId,
    summary,
    evidenceUsed: [{
      evidenceId: artifacts.action.id,
      source: 'routine_request',
      summary: evidenceSummary,
      relevance,
    }],
    preferencesInvoked: [],
    confidenceReasoning: artifacts.risk.reasoning,
    actionRationale: `${artifacts.action.reasoning} Policy result: ${policy.reason}`,
    escalationRationale: policy.reason,
    correctionGuidance: disposition === 'requires-approval'
      ? 'Use a supported approval flow before trying this operation again.'
      : 'Review the policy result and retry only after this operation is supported.',
    riskTier: artifacts.risk.overallTier,
    overallConfidence: artifacts.action.confidence,
    createdAt: new Date(),
  };
}

function routineRegistrationIdempotencyKey(
  suppliedKey: string | undefined,
  schedule: string,
  actionType: string,
  action: ExecutionPlan['action'],
): string {
  const material = suppliedKey?.trim() || stableJson({
    schedule,
    actionType,
    domain: action.domain,
    parameters: action.parameters,
  });
  return createHash('sha256').update(material).digest('hex');
}

function normalizeActionType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_ACTION_TYPE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function serializeCandidate(action: CandidateAction): Record<string, unknown> {
  return {
    id: action.id,
    decisionId: action.decisionId,
    actionType: action.actionType,
    description: action.description,
    domain: action.domain,
    parameters: action.parameters,
    estimatedCostCents: action.estimatedCostCents,
    costZeroIntent: action.costZeroIntent,
    reversible: action.reversible,
    confidence: action.confidence,
    reasoning: action.reasoning,
    provenance: action.provenance,
  };
}
