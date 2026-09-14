import { Router } from 'express';
import {
  classifyDualConfirmStep,
  FIRST_CONFIRMATION_WINDOW_MS,
} from './dual-confirm.js';
import {
  approvalRepository,
  decisionRepository,
  decisionRepositoryAdapter,
  executionAdmissionRepository,
  executionRepository,
  feedbackRepository,
  mempalaceRepository,
  memoryActionOpportunityRepository,
  userRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  policyRepositoryAdapter,
  getPolicyAuthorityRevision,
} from '@skytwin/db';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import type { PolicyDecision } from '@skytwin/policy-engine';
import { RiskAssessor } from '@skytwin/decision-engine';
import {
  AmbiguousExecutionError,
  NoRequestExecutionError,
} from '@skytwin/execution-router';
import type { ExecutionRouter, PreparedExecution } from '@skytwin/execution-router';
import type {
  FeedbackEvent,
  CandidateAction,
  ActionProvenance,
  MemoryActionLoopReport,
  MemoryActionOpportunityStatus,
} from '@skytwin/shared-types';
import {
  ConfidenceLevel,
  normalizeAdapterOutput,
  normalizeExecutionError,
  TrustTier,
} from '@skytwin/shared-types';
import { readAutonomy } from '../cost-gate.js';
import { isValidUserId as isValidUuid } from '../middleware/validate-uuid.js';
import { getExecutionRouter } from '../execution-setup.js';
import { recordMcpActionSpend } from '../mcp-action-spend.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';
import { sseManager } from '../sse.js';
import { createLogger } from '@skytwin/core';
import { getMemoryPortForUser } from '../memory-setup.js';
import { applyDraftEditOverride } from './draft-edit-merge.js';
import {
  matchesApprovalActionSnapshot,
  serializeApprovalCandidate,
} from './approval-candidate.js';
import {
  annotateEmailAttributionPreview,
  isOutboundEmailAction,
  prepareEmailActionForExecution,
} from '../email-attribution.js';

const log = createLogger('api:approvals');

async function bestEffortApprovalLedger(
  label: string,
  write: () => Promise<unknown>,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    log.error(`Failed to ${label}; durable admission remains non-replayable`, {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function parseCostZeroIntent(value: unknown): CandidateAction['costZeroIntent'] {
  if (value === undefined) return undefined;
  return value === 'unknown' || value === 'verified_zero' ? value : 'unknown';
}

function parseActionProvenance(value: unknown): ActionProvenance | undefined {
  if (value === 'user_originated' || value === 'trusted_context' || value === 'untrusted_external') {
    return value;
  }
  return undefined;
}

function executionIsPaused(
  user: Awaited<ReturnType<typeof userRepository.findById>>,
  evaluator: PolicyEvaluator,
): boolean {
  return Boolean(readAutonomy(user).paused) || evaluator.isGloballyPaused();
}

interface ApprovalMemoryLedgerInput {
  approval: {
    id: string;
    decision_id: string;
    candidate_action: unknown;
  };
  action: 'approve' | 'reject';
  executionResult?: { status: string; planId?: string; adapterUsed?: unknown; error?: string } | null;
  overrideStatus?: MemoryActionOpportunityStatus;
  policyReason?: string;
  reason?: string;
}

function memoryOpportunityIdFromAction(action: Record<string, unknown>): string | null {
  const parameters = action['parameters'];
  if (!parameters || typeof parameters !== 'object') return null;
  const opportunityId = (parameters as Record<string, unknown>)['opportunityId'];
  return typeof opportunityId === 'string' && isValidUuid(opportunityId) ? opportunityId : null;
}

async function markMemoryOpportunityFromApproval(input: ApprovalMemoryLedgerInput): Promise<void> {
  const storedAction = (input.approval.candidate_action ?? {}) as Record<string, unknown>;
  const opportunityId = memoryOpportunityIdFromAction(storedAction);
  if (!opportunityId) return;

  const actionType = typeof storedAction['actionType'] === 'string'
    ? storedAction['actionType']
    : 'unknown';
  const actionLabel = typeof storedAction['description'] === 'string' && storedAction['description']
    ? storedAction['description']
    : actionType;
  const parameters = (storedAction['parameters'] ?? {}) as Record<string, unknown>;
  const title = typeof parameters['summary'] === 'string' && parameters['summary']
    ? parameters['summary']
    : actionLabel;
  const adapterName = typeof input.executionResult?.adapterUsed === 'string'
    ? input.executionResult.adapterUsed
    : undefined;
  const status = input.overrideStatus ?? approvalMemoryStatus(input.action, input.executionResult);
  const { summary, nextStep } = approvalMemoryCopy({
    status,
    actionLabel,
    policyReason: input.policyReason,
    error: input.executionResult?.error,
    reason: input.reason,
  });
  const report: MemoryActionLoopReport = {
    opportunityId,
    status,
    title,
    actionType,
    actionLabel,
    adapterName,
    decisionId: input.approval.decision_id,
    approvalRequestId: input.approval.id,
    executionPlanId: input.executionResult?.planId,
    policyReason: input.policyReason,
    summary,
    nextStep,
    attemptedAt: new Date().toISOString(),
  };

  try {
    await memoryActionOpportunityRepository.markStatus({
      id: opportunityId,
      status,
      report,
      decisionId: input.approval.decision_id,
      approvalRequestId: input.approval.id,
      executionPlanId: input.executionResult?.planId,
      adapterName,
      policyReason: input.policyReason,
      nextStep,
    });
  } catch (err) {
    log.warn('Failed to update memory action opportunity after approval response', {
      decisionId: input.approval.decision_id,
      approvalId: input.approval.id,
      opportunityId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function approvalMemoryStatus(
  action: 'approve' | 'reject',
  executionResult?: { status: string } | null,
): MemoryActionOpportunityStatus {
  if (action === 'reject') return 'skipped';
  if (executionResult?.status === 'completed') return 'auto_executed';
  if (executionResult?.status === 'ambiguous') return 'execution_ambiguous';
  return 'execution_failed';
}

function approvalMemoryCopy(input: {
  status: MemoryActionOpportunityStatus;
  actionLabel: string;
  policyReason?: string;
  error?: string;
  reason?: string;
}): { summary: string; nextStep: string } {
  if (input.status === 'skipped') {
    return {
      summary: `User rejected this memory action${input.reason ? `: ${input.reason}` : '.'}`,
      nextStep: 'Keep this feedback in memory; hide the source memory if it should not resurface.',
    };
  }
  if (input.status === 'blocked_by_policy') {
    return {
      summary: `Policy blocked the approved memory action: ${input.policyReason ?? 'policy check failed'}.`,
      nextStep: 'Update policy or autonomy settings before retrying this opportunity.',
    };
  }
  if (input.status === 'auto_executed') {
    return {
      summary: `User approved and SkyTwin executed this memory action: ${input.actionLabel}.`,
      nextStep: 'Monitor feedback and keep the pattern available for future opportunities.',
    };
  }
  if (input.status === 'execution_ambiguous') {
    return {
      summary: `User approved this memory action, but its execution outcome is unresolved: ${input.actionLabel}.`,
      nextStep: 'Reconcile the adapter result before considering another execution.',
    };
  }
  return {
    summary:
      `User approved this memory action, but execution failed: ${input.error ?? 'adapter or persistence failure'}.`,
    nextStep: 'Reconcile this admitted failure before creating a new opportunity.',
  };
}

/**
 * Create the approvals handling router.
 */
export function createApprovalsRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());
  const getRouter = () => getExecutionRouter();

  /**
   * GET /api/approvals/:userId/pending
   *
   * List pending approval requests for a user.
   */
  router.get('/:userId/pending', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const limit = Math.min(Number(req.query['limit']) || 100, 500);
      const approvals = await approvalRepository.findPending(userId, limit);

      // Batch-fetch decisions and candidate actions in two queries instead of N+1
      const decisionIds = [...new Set(approvals.map((a) => a.decision_id).filter(Boolean))] as string[];
      const [decisions, allCandidates, user] = await Promise.all([
        decisionRepository.findByIds(decisionIds),
        decisionRepository.getCandidateActionsForDecisions(decisionIds),
        userRepository.findById(userId!),
      ]);

      const decisionMap = new Map(decisions.map((d) => [d.id, d]));
      const candidateMap = new Map<string, typeof allCandidates>();
      for (const c of allCandidates) {
        const list = candidateMap.get(c.decision_id) ?? [];
        list.push(c);
        candidateMap.set(c.decision_id, list);
      }

      const sensitiveKeys = new Set(['accessToken', 'oauthToken', 'refreshToken', 'credentials']);

      const enriched = approvals.map((a) => {
        const action = a.candidate_action as Record<string, unknown>;
        const isEscalation = action?.['actionType'] === 'escalate_to_user';

        let signalContext: Record<string, unknown> | null = null;
        let alternatives: Array<Record<string, unknown>> = [];

        if (a.decision_id) {
          const decision = decisionMap.get(a.decision_id);
          if (decision) {
            const raw = decision.raw_event ?? {};
            signalContext = {
              summary: (decision.interpreted_situation?.['summary'] as string) ?? decision.domain,
              source: raw['source'] ?? raw['type'] ?? decision.domain,
              from: raw['from'] ?? null,
              subject: raw['subject'] ?? null,
              body: raw['body'] ?? null,
              receivedAt: raw['receivedAt'] ?? null,
            };

            if (isEscalation) {
              const candidates = candidateMap.get(a.decision_id) ?? [];
              alternatives = candidates
                .filter((c) => c.action_type !== 'escalate_to_user')
                .map((c) => {
                  const rawParams = (c.parameters ?? {}) as Record<string, unknown>;
                  const safeParams = Object.fromEntries(
                    Object.entries(rawParams).filter(([k]) => !sensitiveKeys.has(k)),
                  );
                  return {
                    actionType: c.action_type,
                    description: c.description,
                    parameters: safeParams,
                    reversible: c.reversible,
                    estimatedCost: c.estimated_cost,
                  };
                });
            }
          }
        }

        let candidateAction = a.candidate_action;
        const rawAction = (candidateAction ?? {}) as Record<string, unknown>;
        const actionType = typeof rawAction['actionType'] === 'string'
          ? rawAction['actionType']
          : '';
        if (isOutboundEmailAction(actionType)) {
          candidateAction = {
            ...rawAction,
            parameters: annotateEmailAttributionPreview(
              (rawAction['parameters'] as Record<string, unknown> | undefined) ?? {},
              user,
            ),
          };
        }

        return {
          id: a.id,
          userId: a.user_id,
          decisionId: a.decision_id,
          candidateAction,
          signalContext,
          alternatives,
          reason: a.reason,
          urgency: a.urgency,
          status: a.status,
          requestedAt: a.requested_at,
          // 'single' | 'dual'. The web UI renders a two-step confirm for
          // 'dual' (extreme-severity actions flagged by the injection guard).
          confirmationLevel: a.confirmation_level ?? 'single',
          // True once the first of a dual confirmation has landed — lets the
          // UI restore the "confirm again" state across a refresh.
          firstConfirmed: Boolean(a.first_confirmed_at),
        };
      });

      res.json({ approvals: enriched });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/approvals/:userId/history
   *
   * List all approval requests for a user (including resolved).
   */
  router.get('/:userId/history', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const limit = Math.min(Number(req.query['limit']) || 50, 500);
      const approvals = await approvalRepository.findByUser(userId, limit);

      res.json({
        approvals: approvals.map((a) => ({
          id: a.id,
          userId: a.user_id,
          decisionId: a.decision_id,
          candidateAction: a.candidate_action,
          reason: a.reason,
          urgency: a.urgency,
          status: a.status,
          requestedAt: a.requested_at,
          respondedAt: a.responded_at,
          response: a.response,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/approvals/:requestId/respond
   *
   * Approve or reject an approval request and feed back into the twin.
   */
  router.post('/:requestId/respond', async (req, res, next) => {
    try {
      const { requestId } = req.params;
      if (!requestId) {
        res.status(400).json({ error: 'Missing requestId parameter' });
        return;
      }

      const body = req.body as {
        action: 'approve' | 'reject';
        reason?: string;
        userId: string;
        /** Required on the SECOND confirmation of a dual-confirmation
         *  request — the one-time token returned by the first confirmation. */
        confirmationToken?: string;
        /**
         * #303: when approving a `draft_email` candidate, the user may
         * have edited the body in the dashboard textarea before
         * clicking Send. The edited text overrides
         * `parameters.draftBody` before the action executes so the
         * sent email matches what the user reviewed. Ignored on
         * reject and on non-draft action types.
         */
        editedBody?: string;
      };

      if (!body.action || !body.userId) {
        res.status(400).json({ error: 'Missing required fields: action, userId' });
        return;
      }

      if (body.action !== 'approve' && body.action !== 'reject') {
        res.status(400).json({ error: 'action must be "approve" or "reject"' });
        return;
      }

      // Verify ownership before mutating state
      const existing = await approvalRepository.findById(requestId);
      if (!existing) {
        res.status(404).json({ error: 'Approval request not found' });
        return;
      }
      if (existing.user_id !== body.userId) {
        res.status(403).json({ error: 'You can only respond to your own approval requests.' });
        return;
      }

      // ── Dual-confirmation gate (documentary-poisoning injection guard) ──
      // Extreme-severity actions are written with confirmation_level='dual'.
      // Approving one takes two distinct, token-gated clicks. The branching
      // logic is a pure classifier (see ./dual-confirm.ts) so it can be unit
      // tested without the full route harness.
      const dualStep = classifyDualConfirmStep(existing, body);
      if (dualStep.kind === 'reject') {
        res.status(dualStep.httpStatus).json({ error: dualStep.error });
        return;
      }
      if (dualStep.kind === 'issue-first') {
        // FIRST confirmation — mint a one-time token, do NOT execute. The
        // request stays pending until the token-bearing second confirmation.
        const token = await approvalRepository.recordFirstConfirmation(
          requestId,
          body.userId,
        );
        if (!token) {
          res.status(409).json({ error: 'Approval request is no longer pending' });
          return;
        }
        res.json({
          status: 'awaiting_second_confirmation',
          confirmationLevel: 'dual',
          confirmationToken: token,
          expiresInSeconds: FIRST_CONFIRMATION_WINDOW_MS / 1000,
          message:
            'This action is extreme-severity and requires two confirmations. ' +
            'Confirm again with the confirmationToken to execute. The token ' +
            'expires in 10 minutes.',
        });
        return;
      }
      // dualStep.kind is 'not-applicable' (single confirmation / reject) or
      // 'proceed' (valid second confirmation) — both fall through to the
      // normal approve/reject flow below.

      // Pre-flight: on an APPROVE, confirm the persisted RiskAssessment
      // exists for this candidate BEFORE we mutate any state (#371,
      // Copilot review on PR #417). Pre-fix this check ran after
      // approvalRepository.respond() + feedback + memory writes — a
      // missing assessment left an "approved" row with no execution and
      // no way to retry. Now we look at the stored candidate_action,
      // peel the id, look up the assessment, and 409 early if it's
      // missing. Reject path skips this check entirely (no execution).
      let preflightRiskAssessment: Awaited<
        ReturnType<typeof decisionRepositoryAdapter.getRiskAssessment>
      > = null;
      let preflightCandidateId: string | null = null;
      let approvedCandidateAction: CandidateAction | null = null;
      let approvedSourceRisk: ReturnType<RiskAssessor['assess']> | null = null;
      let approvedRiskAssessment: ReturnType<RiskAssessor['assess']> | null = null;
      let approvedPolicyResult: PolicyDecision | null = null;
      let approvedPreparedExecution: PreparedExecution | null = null;
      let approvedExecutionRouter: ExecutionRouter | null = null;
      let approvedActionSnapshot: Record<string, unknown> | null = null;
      let approvedOutcomeSnapshot: Record<string, unknown> | null = null;
      if (body.action === 'approve') {
        const preStoredAction = (existing.candidate_action ?? {}) as Record<string, unknown>;
        const preStoredId = preStoredAction['id'];
        preflightCandidateId =
          typeof preStoredId === 'string' && isValidUuid(preStoredId)
            ? preStoredId
            : null;
        preflightRiskAssessment = preflightCandidateId
          ? await decisionRepositoryAdapter.getRiskAssessment(preflightCandidateId)
          : null;
        if (!preflightRiskAssessment) {
          log.warn('Approve blocked at preflight: no persisted risk assessment for candidate', {
            decisionId: existing.decision_id,
            candidateId: preflightCandidateId,
            approvalId: existing.id,
            userId: body.userId,
          });
          res.status(409).json({
            error: 'risk_assessment_missing',
            message:
              'This approval cannot be executed: the original risk assessment is not on file. ' +
              'Re-trigger the decision to regenerate it. The approval row is unchanged so you can retry.',
            approvalId: existing.id,
            requestId,
          });
          return;
        }

        // Construct the exact eventual action before consuming the approval.
        // Editing a draft and converting it to a send changes both parameters
        // and reversibility, so the original draft risk is source integrity,
        // never execution-time authority.
        approvedCandidateAction = {
          id: preflightCandidateId!,
          decisionId: existing.decision_id,
          actionType: (preStoredAction['actionType'] as string) ?? 'unknown',
          description: (preStoredAction['description'] as string) ?? '',
          domain: (preStoredAction['domain'] as string) ?? 'general',
          parameters: { ...((preStoredAction['parameters'] as Record<string, unknown>) ?? {}) },
          estimatedCostCents: (preStoredAction['estimatedCostCents'] as number) ?? 0,
          costZeroIntent: parseCostZeroIntent(preStoredAction['costZeroIntent']),
          reversible: (preStoredAction['reversible'] as boolean) ?? true,
          confidence: (preStoredAction['confidence'] as ConfidenceLevel) ?? ConfidenceLevel.LOW,
          reasoning: (preStoredAction['reasoning'] as string) ?? '',
          provenance: parseActionProvenance(preStoredAction['provenance']),
        };
        applyDraftEditOverride(approvedCandidateAction, body.editedBody);
        const currentUser = await userRepository.findById(body.userId);
        prepareEmailActionForExecution(approvedCandidateAction, currentUser);
        approvedSourceRisk = new RiskAssessor().assess(approvedCandidateAction);
        approvedExecutionRouter = await getRouter();
        approvedPreparedExecution = await approvedExecutionRouter.prepareExecution(
          approvedCandidateAction,
          approvedSourceRisk,
          body.userId,
          {
            approved: true,
            streaming: false,
            ironclawChannel: currentUser?.ironclaw_channel ?? undefined,
          },
        );
        approvedRiskAssessment = approvedPreparedExecution.riskAssessment;
        const currentPolicies = await policyRepositoryAdapter.getAllPolicies();
        const approvedPolicyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);
        approvedPolicyResult = await approvedPolicyEvaluator.evaluate(
          approvedCandidateAction,
          currentPolicies,
          currentUser?.trust_tier as TrustTier ?? TrustTier.OBSERVER,
          approvedRiskAssessment,
          readAutonomy(currentUser),
        );
        if (!approvedPolicyResult.allowed || executionIsPaused(currentUser, approvedPolicyEvaluator)) {
          res.status(403).json({
            error: 'Action blocked by current policy.',
            reason: approvedPolicyResult.reason,
            requestId,
          });
          return;
        }
        if (approvedPolicyResult.confirmationLevel === 'dual' &&
            existing.confirmation_level !== 'dual') {
          res.status(409).json({
            error: 'confirmation_level_changed',
            message: 'The edited action now requires two confirmations. Re-trigger it for review.',
            requestId,
          });
          return;
        }
        approvedActionSnapshot = {
          decisionId: existing.decision_id,
          ...serializeApprovalCandidate(
            approvedCandidateAction,
            approvedCandidateAction.parameters,
          ),
        };
        approvedOutcomeSnapshot = {
          decisionId: existing.decision_id,
          selectedAction: approvedActionSnapshot,
          autoExecute: true,
          requiresApproval: false,
          reasoning: `User approved the exact action after current policy evaluation. ${approvedPolicyResult.reason}`,
        };
      }

      // Atomically update only if still pending (prevents double-execution)
      const approval = await approvalRepository.respond(requestId, body.action, body.userId, body.reason);
      if (!approval) {
        res.status(409).json({ error: 'Approval request is no longer pending' });
        return;
      }

      // Submit feedback to close the loop
      const savedFeedback = await feedbackRepository.create({
        userId: body.userId,
        decisionId: approval.decision_id,
        type: body.action,
        data: { reason: body.reason ?? null, approvalRequestId: requestId },
      });

      const feedbackEvent: FeedbackEvent = {
        id: savedFeedback.id,
        userId: body.userId,
        decisionId: approval.decision_id,
        feedbackType: body.action === 'approve' ? 'approve' : 'reject',
        reason: body.reason,
        timestamp: new Date(),
      };

      const updatedProfile = await twinService.processFeedback(body.userId, feedbackEvent);

      // Record an episode in the memory layer (#197). Future similar
      // decisions will pull this back via DecisionContext.episodicMemories
      // and DecisionMaker.calculateEpisodicBoost will tilt scoring toward
      // (or away from) the user's chosen path. Approve → utility 0.9;
      // reject → utility 0.0 → next time the same candidate comes up its
      // boost will be negative-ish, lowering its score and making it more
      // likely to be requeued for approval rather than picked outright.
      try {
        const decision = await decisionRepository.findById(approval.decision_id);
        const storedAction = (approval.candidate_action ?? {}) as Record<string, unknown>;
        const actionType = (storedAction['actionType'] as string) ?? 'unknown';
        const interpretedSummary =
          (decision?.interpreted_situation?.['summary'] as string | undefined) ??
          undefined;
        const summary = interpretedSummary ?? `User ${body.action}d ${actionType}`;
        const episodeRow = await mempalaceRepository.createEpisode({
          userId: body.userId,
          situationSummary: summary,
          domain: decision?.domain ?? 'general',
          situationType: decision?.situation_type ?? 'generic',
          contextSnapshot: {
            timeOfDay: undefined,
            dayOfWeek: undefined,
            urgency: undefined,
            activePreferences: [],
            activePatterns: [],
          },
          actionTaken: actionType,
          feedbackType: body.action === 'approve' ? 'approve' : 'reject',
          feedbackDetail: body.reason,
          decisionId: approval.decision_id,
          utilityScore: body.action === 'approve' ? 0.9 : 0.0,
        });

        // Also push the episode into the gbrain memory backend so its
        // semantic index covers approved/rejected outcomes (#197).
        const resolved = await getMemoryPortForUser(body.userId);
        await resolved.port
          .recordEpisode({
            id: episodeRow.id,
            userId: body.userId,
            wing: decision?.domain ?? undefined,
            summary,
            startedAt: new Date(),
            endedAt: new Date(),
            metadata: {
              feedbackType: body.action,
              actionType,
              utilityScore: body.action === 'approve' ? 0.9 : 0.0,
            },
          })
          .catch((portErr) => {
            log.warn('Memory port recordEpisode failed (legacy table updated regardless)', {
              decisionId: approval.decision_id,
              error: portErr instanceof Error ? portErr.message : String(portErr),
            });
          });

        // Tell the dashboard. The memory-settings page subscribes and
        // refreshes its "recent decisions" table + feedback histogram
        // without polling. Best-effort SSE — never gates the approval.
        try {
          sseManager.emit(body.userId, 'memory:episode-recorded', {
            episodeId: episodeRow.id,
            decisionId: approval.decision_id,
            actionType,
            feedbackType: body.action,
            summary,
          });
        } catch {
          // sseManager.emit is synchronous; an internal throw is non-fatal.
        }
      } catch (err) {
        // Episode recording is best-effort — never block the approval
        // response on a memory-layer hiccup.
        log.warn('Failed to record approval episode for memory layer', {
          decisionId: approval.decision_id,
          action: body.action,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // If approved, execute via the trust-ranked execution router
      let executionResult: { status: string; planId?: string; adapterUsed?: unknown; error?: string } | null = null;
      if (body.action === 'approve') {
        const storedAction = approval.candidate_action as Record<string, unknown>;
        const candidateAction = approvedCandidateAction!;
        const actionSnapshot = approvedActionSnapshot!;
        const outcomeSnapshot = approvedOutcomeSnapshot!;

        let admissionAttempted = false;
        let observedTerminal = false;
        let admittedAuthority: {
          userId: string;
          decisionId: string;
          actionId: string;
          executionPlanId: string;
          adapterName: string;
          steps: Array<{ type: string; status: string }>;
          riskSnapshot: Record<string, unknown>;
          policySnapshot: Record<string, unknown>;
          actionSnapshot: Record<string, unknown>;
          outcomeSnapshot: Record<string, unknown>;
        } | null = null;
        try {
          const executionRouter = approvedExecutionRouter!;
          executionAttempt: {
            const admissionUser = await userRepository.findById(body.userId);
            const prepared = approvedPreparedExecution!;
            const admissionRisk = prepared.riskAssessment;
            const admissionPolicies = await policyRepositoryAdapter.getAllPolicies();
            const admissionPolicyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);
            const admissionPolicy = await admissionPolicyEvaluator.evaluate(
              candidateAction,
              admissionPolicies,
              admissionUser?.trust_tier as TrustTier ?? TrustTier.OBSERVER,
              admissionRisk,
              readAutonomy(admissionUser),
            );
            const admissionPaused = executionIsPaused(admissionUser, admissionPolicyEvaluator);
            const admissionDualMismatch = admissionPolicy.confirmationLevel === 'dual' &&
              approval.confirmation_level !== 'dual';
            if (!admissionPolicy.allowed || admissionPaused || admissionDualMismatch) {
              const denialReason = admissionPaused
                ? 'Execution is paused by current user or operator policy.'
                : admissionDualMismatch
                  ? 'The exact prepared action now requires dual confirmation.'
                  : admissionPolicy.reason;
              const denial = await executionAdmissionRepository.recordPolicyDenial({
                scope: 'approval',
                userId: body.userId,
                decisionId: approval.decision_id,
                actionId: candidateAction.id,
                approvalId: approval.id,
                adapterName: prepared.adapterName,
                actionSnapshot,
                riskSnapshot: admissionRisk as unknown as Record<string, unknown>,
                policySnapshot: {
                  ...admissionPolicy,
                  allowed: false,
                  dispatchDenied: true,
                  denialReason,
                },
                reason: denialReason,
              });
              if (!denial) {
                throw new Error('Approved execution denial evidence could not be persisted.');
              }
              executionResult = {
                status: 'blocked',
                error: denialReason,
              };
              break executionAttempt;
            }
            const admissionOutcomeSnapshot = {
              ...outcomeSnapshot,
              reasoning: `User approved the exact action after current policy evaluation. ${admissionPolicy.reason}`,
            };
            const admissionAuthority = {
              userId: body.userId,
              decisionId: approval.decision_id,
              actionId: candidateAction.id,
              executionPlanId: prepared.planId,
              adapterName: prepared.adapterName,
              steps: [{ type: candidateAction.actionType, status: 'pending' }],
              riskSnapshot: admissionRisk as unknown as Record<string, unknown>,
              policySnapshot: admissionPolicy as unknown as Record<string, unknown>,
              actionSnapshot,
              outcomeSnapshot: admissionOutcomeSnapshot,
            };
            admittedAuthority = admissionAuthority;
            admissionAttempted = true;
            const admission = await executionAdmissionRepository.admitApprovalExecution({
              ...admissionAuthority,
              approvalId: approval.id,
              sourceRiskSnapshot: preflightRiskAssessment as unknown as Record<string, unknown>,
              preEffectExplanation: {
                whatHappened: 'SkyTwin admitted the exact user-approved action after current policy and risk evaluation.',
                evidenceUsed: [{ approvalId: approval.id, action: actionSnapshot }],
                preferencesInvoked: [],
                confidenceReasoning: admissionRisk.reasoning,
                actionRationale: candidateAction.reasoning,
                escalationRationale: null,
                correctionGuidance: 'Review the approved action snapshot and terminal adapter observation.',
              },
              memoryOpportunityId: memoryOpportunityIdFromAction(storedAction) ?? undefined,
            });
            if (!admission.created) {
              const recordedStatus = admission.barrier.status;
              executionResult = {
                status: recordedStatus === 'completed' || recordedStatus === 'failed'
                  ? recordedStatus
                  : 'ambiguous',
                planId: admission.plan.id,
                adapterUsed: admission.barrier.observed_result['adapterUsed'],
                ...(recordedStatus === 'failed'
                  ? { error: 'Execution failed' }
                  : recordedStatus === 'completed'
                    ? {}
                    : { error: 'Execution outcome requires reconciliation' }),
              };
              log.warn('Duplicate approved execution was suppressed by durable admission', {
                requestId,
                executionPlanId: admission.plan.id,
                admissionStatus: recordedStatus,
              });
              break executionAttempt;
            }

            const dispatchUser = await userRepository.findById(body.userId);
            const dispatchPolicyRevision = await getPolicyAuthorityRevision();
            const dispatchPolicies = await policyRepositoryAdapter.getAllPolicies();
            const dispatchPolicyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);
            const dispatchPolicy = await dispatchPolicyEvaluator.evaluate(
              candidateAction,
              dispatchPolicies,
              dispatchUser?.trust_tier as TrustTier ?? TrustTier.OBSERVER,
              admissionRisk,
              readAutonomy(dispatchUser),
            );
            if (!matchesApprovalActionSnapshot(candidateAction, actionSnapshot) ||
                !dispatchPolicy.allowed ||
                executionIsPaused(dispatchUser, dispatchPolicyEvaluator) ||
                dispatchPolicy.requiresApproval !== admissionPolicy.requiresApproval ||
                !await executionAdmissionRepository.isDispatchable(admission, {
                  ...admissionAuthority,
                  policySnapshot: dispatchPolicy as unknown as Record<string, unknown>,
                })) {
              try {
                await executionAdmissionRepository.failBeforeDispatch({
                  admission,
                  userId: body.userId,
                  error: 'Execution authority was revoked before router invocation.',
                });
                executionResult = {
                  status: 'failed',
                  planId: admission.plan.id,
                  error: 'Execution authority was revoked before dispatch',
                };
              } catch {
                executionResult = {
                  status: 'ambiguous',
                  planId: admission.plan.id,
                  error: 'Execution authority could not be reconciled before dispatch',
                };
              }
              break executionAttempt;
            }

            let result: Awaited<ReturnType<typeof executionRouter.executePrepared>>;
            try {
              // Approved-execution path: a human moved this through the approval
              // flow (and, for dual-confirmation actions, clicked twice — the
              // confirm-token check above enforces the count). Pass
              // `{ approved: true }` so the router's injection-guard backstop
              // lets the action through; the human already supplied the
              // confirmation the guard demanded.
              result = await executionRouter.executePrepared(
                prepared,
                {
                  ...candidateAction,
                  parameters: {
                    ...candidateAction.parameters,
                    executionPlanId: admission.plan.id,
                    credentialAuthorityRevision: dispatchUser?.execution_authority_revision,
                    credentialPolicyAuthorityRevision: dispatchPolicyRevision,
                    dispatchAuthorityId: admission.barrier.id,
                    dispatchAuthorityUpdatedAt: admission.barrier.updated_at.toISOString(),
                  },
                },
                admissionRisk,
                body.userId,
                {
                  approved: true,
                  ironclawChannel: dispatchUser?.ironclaw_channel ?? undefined,
                },
              );
              if (result.status !== 'completed' && result.status !== 'failed') {
                throw new AmbiguousExecutionError(
                  `Approved execution returned non-terminal status ${result.status}`,
                );
              }
            } catch (dispatchError) {
              const errMsg = normalizeExecutionError(dispatchError);
              if (dispatchError instanceof NoRequestExecutionError) {
                try {
                  await executionAdmissionRepository.failBeforeDispatch({
                    admission,
                    userId: body.userId,
                    error: errMsg,
                  });
                  executionResult = {
                    status: 'failed',
                    planId: admission.plan.id,
                    error: 'Execution was refused before request start',
                  };
                } catch {
                  executionResult = {
                    status: 'ambiguous',
                    planId: admission.plan.id,
                    error: 'Execution outcome requires reconciliation',
                  };
                }
                break executionAttempt;
              }
              await bestEffortApprovalLedger('record ambiguous approved execution admission', () =>
                executionAdmissionRepository.observeTerminal({
                  id: admission.barrier.id,
                  userId: body.userId,
                  status: 'ambiguous',
                  result: { planId: admission.plan.id, error: errMsg },
                }), { requestId, executionPlanId: admission.plan.id });
              executionResult = {
                status: 'ambiguous',
                planId: admission.plan.id,
                error: 'Execution outcome requires reconciliation',
              };
              break executionAttempt;
            }

            const terminalStatus: 'completed' | 'failed' = result.status;
            const safeOutput = normalizeAdapterOutput(result.output ?? {});
            const safeError = result.error
              ? normalizeExecutionError(result.error)
              : undefined;
            const adapterUsed = safeOutput['adapter_used'] ?? 'unknown';
            // Preserve the explicit adapter result before any persistence whose
            // commit response can be lost. No later catch may rewrite it.
            executionResult = {
              status: terminalStatus,
              planId: admission.plan.id,
              adapterUsed,
              ...(result.status === 'failed' ? { error: safeError ?? 'Execution failed' } : {}),
            };
            observedTerminal = true;
            await bestEffortApprovalLedger('record terminal approved execution admission', () =>
              executionAdmissionRepository.observeTerminal({
                id: admission.barrier.id,
                userId: body.userId,
                status: terminalStatus,
                result: {
                  planId: admission.plan.id,
                  adapterPlanId: result.planId,
                  adapterUsed,
                  status: terminalStatus,
                  output: safeOutput,
                  error: safeError ?? null,
                },
              }), { requestId, executionPlanId: admission.plan.id });
            await bestEffortApprovalLedger('finalize admitted approved execution plan', () =>
              executionRepository.finalizeAdmittedPlan({
                userId: body.userId,
                decisionId: approval.decision_id,
                actionId: candidateAction.id,
                planId: admission.plan.id,
                status: terminalStatus,
                success: terminalStatus === 'completed',
                outputs: { ...safeOutput, adapter_plan_id: result.planId },
                error: safeError,
                rollbackAvailable: typeof safeOutput['rollback_available'] === 'boolean'
                  ? safeOutput['rollback_available']
                  : candidateAction.reversible,
              }), { requestId, executionPlanId: admission.plan.id });

            // Record post-execution spend tagged with the action's
            // registry source (#323 AC#3). Only on success — a failed
            // approved execution shouldn't charge the per-app budget.
            // Best-effort: the helper swallows its own errors so a ledger
            // write can't break the approval response. The spend cap was
            // re-checked by the policy evaluation above before execution.
            if (result.status === 'completed') {
              await recordMcpActionSpend({
                userId: body.userId,
                decisionId: approval.decision_id,
                action: candidateAction,
              });
            }
          }
        } catch (execError) {
          const errMsg = normalizeExecutionError(execError);
          if (observedTerminal) {
            log.error('Known approved execution result needs secondary-ledger reconciliation', {
              requestId,
              error: errMsg,
            });
          } else if (admissionAttempted) {
            // A lost admission commit response is indistinguishable from a
            // durable in-progress barrier. Fail closed and never dispatch or
            // fabricate a failed recovery plan.
            log.warn(`Approved execution admission is ambiguous for ${requestId}`, { error: errMsg });
            const memoryOpportunityId = memoryOpportunityIdFromAction(storedAction);
            const recovered = admittedAuthority ? await executionAdmissionRepository.findByScope(
              body.userId,
              memoryOpportunityId ? 'memory' : 'approval',
              memoryOpportunityId ?? approval.id,
              admittedAuthority,
            ).catch(() => null) : null;
            const recoveredStatus = recovered?.barrier.status;
            executionResult = recovered &&
              (recoveredStatus === 'completed' || recoveredStatus === 'failed')
              ? {
                  status: recoveredStatus,
                  planId: recovered.plan.id,
                  adapterUsed: recovered.barrier.observed_result['adapterUsed'],
                  ...(recoveredStatus === 'failed' ? { error: 'Execution failed' } : {}),
                }
              : {
                  status: 'ambiguous',
                  planId: recovered?.plan.id,
                  error: 'Execution outcome requires reconciliation',
                };
          } else {
            log.error(`Execution failed for approval ${requestId}`, { error: errMsg, stack: execError instanceof Error ? execError.stack : undefined });
            executionResult = { status: 'failed', error: 'Execution failed before admission' };
          }
        } finally {
          // Always strip sensitive credentials, even on error paths
          delete candidateAction.parameters['accessToken'];
        }
      }

      await markMemoryOpportunityFromApproval({
        approval,
        action: body.action,
        executionResult,
        ...(executionResult?.status === 'blocked' ? {
          overrideStatus: 'blocked_by_policy' as const,
          policyReason: executionResult.error,
        } : {}),
        reason: body.reason,
      });

      // Notify via SSE
      sseManager.emit(body.userId, 'approval:resolved', {
        requestId,
        action: body.action,
        decisionId: approval.decision_id,
        execution: executionResult,
      });

      res.json({
        requestId,
        action: body.action,
        reason: body.reason ?? null,
        approval: {
          id: approval.id,
          status: approval.status,
          respondedAt: approval.responded_at,
        },
        execution: executionResult,
        twinProfileVersion: updatedProfile.version,
        processedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/approvals/:userId/cleanup-escalations
   *
   * Soft-delete stale escalation-only requests from history.
   * These are "escalate_to_user" actions that expired or went past their window
   * without user response — marks them as 'cleaned' to hide from UI.
   */
  router.post('/:userId/cleanup-escalations', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body as Record<string, unknown>;
      const requestingUser = (body['userId'] as string) ?? '';
      if (requestingUser && requestingUser !== userId) {
        res.status(403).json({ error: 'You can only clean up your own escalations.' });
        return;
      }
      const cleaned = await approvalRepository.deleteStaleEscalations(userId);
      res.json({ cleaned });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/approvals/expire-sweep
   *
   * Trigger expiry of stale pending approvals. Restricted to localhost
   * callers (worker process) to prevent any authenticated user from
   * expiring global approval state.
   */
  router.post('/expire-sweep', async (req, res, next) => {
    try {
      const remoteIp = req.ip ?? req.socket.remoteAddress ?? '';
      const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp);
      if (!isLocal) {
        res.status(403).json({ error: 'Expire sweep is restricted to internal callers' });
        return;
      }
      const count = await approvalRepository.expirePending();
      res.json({ expired: count });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
