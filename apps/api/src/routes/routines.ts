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
import {
  classifyGmailArchiveGenericAction,
  TrustTier,
  ConfidenceLevel,
  SituationType,
} from '@skytwin/shared-types';
import { PolicyEvaluator, type PolicyDecision } from '@skytwin/policy-engine';
import { RiskAssessor } from '@skytwin/decision-engine';
import {
  decisionRepositoryAdapter,
  explanationRepositoryAdapter,
  policyRepositoryAdapter,
  preEffectBarrierRepository,
  userRepository,
} from '@skytwin/db';
import { getIronClawEnhancedAdapter } from '../execution-setup.js';
import { readAutonomy } from '../cost-gate.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';

// Cron expression: 5 or 6 space-separated fields, each containing digits, *, /, -, or ,
const CRON_REGEX = /^[0-9*/,-]+( [0-9*/,-]+){4,5}$/;
const MAX_CRON_LENGTH = 128;

// If routine registration is re-enabled after per-run admission exists, it may
// ONLY schedule a known free + reversible action type. Cost/reversibility is
// classified server-side here, never trusted from the request body. Any other
// type is treated as unknown-cost + irreversible, which escalates to
// requiresApproval and is refused (an action needing per-run approval cannot
// run unattended). Outbound/costed/destructive actions are intentionally absent.
// The POST handler currently blocks all registration after recording its audit
// artifacts because the remote scheduler cannot yet enforce per-run admission.
const FREE_ROUTINE_ACTION_TYPES = new Set<string>([
  'create_note',
  'create_document',
  'set_reminder',
  'snooze_reminder',
  'label_email',
  'acknowledge',
  'dismiss',
]);

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

      // Validate cron schedule format
      if (schedule.length > MAX_CRON_LENGTH || !CRON_REGEX.test(schedule)) {
        res.status(400).json({ error: 'Invalid schedule format. Expected a cron expression (e.g., "0 9 * * *").' });
        return;
      }

      // Scheduled archive execution belongs exclusively to the dedicated
      // approval/recovery lifecycle. Keep an explicit boundary guard even
      // while all routine registration is disabled so later reactivation
      // cannot silently route it through generic policy or scheduling.
      const actionClassification = classifyGmailArchiveGenericAction(plan.action);
      if (actionClassification.kind === 'invalid') {
        res.status(400).json({ error: 'Plan must include an action with an actionType.' });
        return;
      }
      if (actionClassification.kind === 'archive') {
        res.status(409).json({
          error: 'archive_email is reserved for its dedicated execution lifecycle.',
        });
        return;
      }

      // Policy check: routines auto-execute, so must pass policy evaluation
      const user = await userRepository.findById(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }
      const userTier = user.trust_tier as TrustTier ?? TrustTier.OBSERVER;
      const policies = await policyRepositoryAdapter.getAllPolicies(userId);
      // A routine auto-executes unattended on a schedule, so its action must
      // clear the FULL policy gate — including the spend hard-limit and the
      // reversibility / risk-dimension escalations, which only fire when BOTH a
      // riskAssessment and autonomySettings are supplied. The previous 3-arg
      // call silently skipped both, so a costed or irreversible plan.action
      // sailed through.
      // plan.action is untrusted request-body input, so the policy check runs
      // against a SERVER-DERIVED action — the caller never gets to assert its own
      // cost, reversibility, or provenance to slip past the gate. Cost +
      // reversibility are classified from the action TYPE: a known free + safe
      // type is verified-zero and reversible; anything else is unknown-cost and
      // assumed irreversible, so it escalates to requiresApproval and is refused.
      const rawAction = plan.action as Partial<CandidateAction>;
      const knownSafe = FREE_ROUTINE_ACTION_TYPES.has(plan.action.actionType);
      const decisionId = randomUUID();
      const action: CandidateAction = {
        id: randomUUID(),
        decisionId,
        actionType: plan.action.actionType,
        description: typeof rawAction.description === 'string' ? rawAction.description : '',
        domain: typeof rawAction.domain === 'string' ? rawAction.domain : 'general',
        parameters:
          rawAction.parameters && typeof rawAction.parameters === 'object'
            ? { ...rawAction.parameters, userId }
            : { userId },
        estimatedCostCents: 0,
        costZeroIntent: knownSafe ? 'verified_zero' : 'unknown',
        reversible: knownSafe,
        confidence: ConfidenceLevel.LOW,
        reasoning: typeof rawAction.reasoning === 'string' ? rawAction.reasoning : 'Scheduled routine action',
        provenance: 'untrusted_external',
      };
      const riskAssessment = new RiskAssessor().assess(action);
      const autonomy = readAutonomy(user);
      const policyResult = await policyEvaluator.evaluate(
        action,
        policies,
        userTier,
        riskAssessment,
        autonomy,
      );

      const idempotencyKey = routineIdempotencyKey(
        typeof req.get('idempotency-key') === 'string' ? req.get('idempotency-key') : undefined,
        schedule,
        action,
      );
      const { row: barrier, created } = await preEffectBarrierRepository.reserve({
        userId,
        effectType: 'routine_registration',
        idempotencyKey,
      });
      if (!created) {
        const priorRoutineId = barrier.effect_result['routineId'];
        if (barrier.status === 'succeeded' && typeof priorRoutineId === 'string') {
          res.status(200).json({ userId, schedule, routineId: priorRoutineId, duplicate: true });
          return;
        }
        res.status(409).json({
          error: 'A matching routine registration is already recorded and will not be replayed automatically.',
          status: barrier.status,
        });
        return;
      }

      const decision = buildRoutineDecision(userId, schedule, action, idempotencyKey);
      await decisionRepositoryAdapter.saveDecision(decision);
      await decisionRepositoryAdapter.saveCandidates([action]);
      await decisionRepositoryAdapter.saveRiskAssessment(riskAssessment);
      const disposition = !policyResult.allowed
        ? 'blocked'
        : policyResult.requiresApproval ? 'requires-approval' : 'allowed';
      const outcome = buildRoutineOutcome(action, riskAssessment, policyResult, disposition);
      await decisionRepositoryAdapter.saveOutcome(outcome);
      const explanation = await explanationRepositoryAdapter.save(
        buildRoutineExplanation(userId, schedule, action, riskAssessment, policyResult, disposition),
      );
      await preEffectBarrierRepository.markPrepared({
        id: barrier.id,
        userId,
        decisionId,
        actionId: action.id,
        explanationId: explanation.id,
        policySnapshot: routinePolicySnapshot(policyResult, action, riskAssessment),
      });

      if (!policyResult.allowed) {
        await preEffectBarrierRepository.markTerminal(userId, barrier.id, 'blocked', {}, policyResult.reason);
        res.status(403).json({
          error: 'Routine blocked by policy.',
          reason: policyResult.reason ?? 'Policy check failed',
        });
        return;
      }
      // Otherwise allowed, but the policy engine says it needs human approval
      // (trust tier, cost, irreversibility, injection guard). A scheduled
      // routine has no human in the loop per run, so it must NOT be registered
      // to auto-run — refuse creation rather than silently auto-executing it.
      if (policyResult.requiresApproval) {
        await preEffectBarrierRepository.markTerminal(userId, barrier.id, 'blocked', {}, policyResult.reason);
        res.status(403).json({
          error: 'Routine blocked: this action requires manual approval and cannot run unattended on a schedule.',
          reason: policyResult.reason ?? 'Action requires manual approval.',
        });
        return;
      }

      // Public-beta safety gate: IronClaw registers a schedule that executes
      // later, outside this request. Until every scheduled run re-enters the
      // policy engine and persists a fresh ExplanationRecord immediately
      // before dispatch, registration is unavailable even when today's policy
      // allows the candidate. Persist that deliberate non-action before
      // returning so the disabled feature has a complete audit trail.
      const runtimeAdmissionPolicy: PolicyDecision = {
        allowed: false,
        requiresApproval: false,
        reason: 'Unattended routines are disabled until every scheduled run has runtime policy and explanation admission.',
      };
      await decisionRepositoryAdapter.saveOutcome(
        buildRoutineOutcome(action, riskAssessment, runtimeAdmissionPolicy, 'blocked'),
      );
      await explanationRepositoryAdapter.save(buildRoutineExplanation(
        userId,
        schedule,
        action,
        riskAssessment,
        runtimeAdmissionPolicy,
        'blocked',
      ));
      await preEffectBarrierRepository.markTerminal(
        userId,
        barrier.id,
        'blocked',
        { runtimeAdmission: 'unavailable' },
        runtimeAdmissionPolicy.reason,
      );
      res.status(503).json({
        error: 'Unattended routine registration is not available in this public beta.',
        reason: runtimeAdmissionPolicy.reason,
      });
      return;
    } catch (error) {
      next(error);
    }
  });

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
      const bodyUserId = (req.body as Record<string, unknown>)?.['userId'];
      const queryUserId = req.query['userId'];
      const userId = typeof bodyUserId === 'string' ? bodyUserId
        : typeof queryUserId === 'string' ? queryUserId
        : undefined;
      if (!userId) {
        res.status(400).json({ error: 'Missing required userId' });
        return;
      }

      const adapter = await getIronClawEnhancedAdapter();
      if (!adapter) {
        res.status(503).json({ error: 'IronClaw routines are unavailable.' });
        return;
      }

      // Verify the routine belongs to the requesting user before deleting
      const routines = await adapter.listRoutines(userId);
      const owns = routines.some((r) => r.id === routineId);
      if (!owns) {
        res.status(403).json({ error: 'Routine not found or does not belong to you.' });
        return;
      }

      const result = await adapter.deleteRoutine(routineId!);
      res.json({ routineId, deleted: result.success });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function routineIdempotencyKey(
  suppliedKey: string | undefined,
  schedule: string,
  action: CandidateAction,
): string {
  const material = suppliedKey?.trim() || stableJson({
    schedule,
    actionType: action.actionType,
    domain: action.domain,
    parameters: action.parameters,
  });
  return createHash('sha256').update(material).digest('hex');
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

function buildRoutineDecision(
  userId: string,
  schedule: string,
  action: CandidateAction,
  idempotencyKey: string,
): DecisionObject {
  return {
    id: action.decisionId,
    situationType: SituationType.GENERIC,
    domain: action.domain,
    urgency: 'medium',
    summary: `Register scheduled ${action.actionType} routine (${schedule}).`,
    rawData: {
      userId,
      signalId: `routine-registration:${idempotencyKey}`,
      schedule,
      normalizedAction: serializeRoutineCandidate(action),
    },
    interpretedAt: new Date(),
    provenance: 'user_originated',
  };
}

type RoutineDisposition = 'allowed' | 'blocked' | 'requires-approval';

function buildRoutineOutcome(
  action: CandidateAction,
  riskAssessment: RiskAssessment,
  policy: PolicyDecision,
  disposition: RoutineDisposition,
): DecisionOutcome {
  return {
    id: randomUUID(),
    decisionId: action.decisionId,
    selectedAction: action,
    allCandidates: [action],
    riskAssessment,
    allRiskAssessments: [riskAssessment],
    autoExecute: disposition === 'allowed',
    requiresApproval: disposition === 'requires-approval',
    reasoning: policy.reason,
    decidedAt: new Date(),
    policyVerdicts: {
      [action.id]: disposition === 'allowed'
        ? 'allowed'
        : disposition === 'requires-approval' ? 'requires-approval' : 'denied',
    },
    confirmationLevel: policy.confirmationLevel,
  };
}

function buildRoutineExplanation(
  userId: string,
  schedule: string,
  action: CandidateAction,
  riskAssessment: RiskAssessment,
  policy: PolicyDecision,
  disposition: RoutineDisposition,
): ExplanationRecord {
  const summary = disposition === 'allowed'
    ? `SkyTwin durably recorded its intent to register the ${action.actionType} routine.`
    : disposition === 'requires-approval'
      ? 'SkyTwin did not register the routine because it requires human approval.'
      : 'SkyTwin did not register the routine because policy blocked it.';
  return {
    id: randomUUID(),
    decisionId: action.decisionId,
    userId,
    summary,
    evidenceUsed: [{
      evidenceId: action.id,
      source: 'routine_request',
      summary: `Normalized ${action.actionType} action scheduled for ${schedule}.`,
      relevance: 'This is the exact server-normalized action evaluated before registration availability was decided.',
    }],
    preferencesInvoked: [],
    confidenceReasoning: riskAssessment.reasoning,
    actionRationale: `${action.reasoning} Policy result: ${policy.reason}`,
    escalationRationale:
      disposition === 'blocked' || disposition === 'requires-approval' ? policy.reason : undefined,
    correctionGuidance:
      'Change the schedule or action, or update policy/autonomy settings, then submit a new idempotency key.',
    riskTier: riskAssessment.overallTier,
    overallConfidence: action.confidence,
    createdAt: new Date(),
  };
}

function routinePolicySnapshot(
  policy: PolicyDecision,
  action: CandidateAction,
  riskAssessment: RiskAssessment,
): Record<string, unknown> {
  return {
    allowed: policy.allowed,
    requiresApproval: policy.requiresApproval,
    reason: policy.reason,
    confirmationLevel: policy.confirmationLevel,
    candidate: serializeRoutineCandidate(action),
    riskAssessment: { ...riskAssessment, assessedAt: riskAssessment.assessedAt.toISOString() },
  };
}

function serializeRoutineCandidate(action: CandidateAction): Record<string, unknown> {
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
