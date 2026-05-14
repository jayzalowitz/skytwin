import { Router } from 'express';
import {
  classifyDualConfirmStep,
  FIRST_CONFIRMATION_WINDOW_MS,
} from './dual-confirm.js';
import {
  approvalRepository,
  decisionRepository,
  feedbackRepository,
  mempalaceRepository,
  oauthRepository,
  userRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  policyRepositoryAdapter,
  withTransaction,
} from '@skytwin/db';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import type { FeedbackEvent, CandidateAction, RiskAssessment, DimensionAssessment } from '@skytwin/shared-types';
import { ConfidenceLevel, RiskTier, RiskDimension, TrustTier } from '@skytwin/shared-types';
import { getExecutionRouter } from '../execution-setup.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { sseManager } from '../sse.js';
import { createLogger } from '@skytwin/core';
import { getMemoryPortForUser } from '../memory-setup.js';

const log = createLogger('api:approvals');

/**
 * Create the approvals handling router.
 */
export function createApprovalsRouter(): Router {
  const router = Router();
  bindUserIdParamOwnership(router);
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());
  const policyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);
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
      const [decisions, allCandidates] = await Promise.all([
        decisionRepository.findByIds(decisionIds),
        decisionRepository.getCandidateActionsForDecisions(decisionIds),
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

        return {
          id: a.id,
          userId: a.user_id,
          decisionId: a.decision_id,
          candidateAction: a.candidate_action,
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
        const candidateAction: CandidateAction = {
          id: crypto.randomUUID(),
          decisionId: approval.decision_id,
          actionType: (storedAction['actionType'] as string) ?? 'unknown',
          description: (storedAction['description'] as string) ?? '',
          domain: (storedAction['domain'] as string) ?? 'general',
          parameters: (storedAction['parameters'] as Record<string, unknown>) ?? {},
          estimatedCostCents: (storedAction['estimatedCostCents'] as number) ?? 0,
          reversible: (storedAction['reversible'] as boolean) ?? true,
          confidence: (storedAction['confidence'] as ConfidenceLevel) ?? ConfidenceLevel.LOW,
          reasoning: (storedAction['reasoning'] as string) ?? '',
        };

        // Run policy check even on approved actions (spend limits, domain restrictions still apply)
        const user = await userRepository.findById(body.userId);
        const userTier = user?.trust_tier as TrustTier ?? TrustTier.OBSERVER;
        if (user?.ironclaw_channel) {
          candidateAction.parameters['ironclawChannel'] = user.ironclaw_channel;
        }
        const policies = await policyRepositoryAdapter.getAllPolicies();
        const policyResult = await policyEvaluator.evaluate(
          candidateAction,
          policies,
          userTier,
        );

        if (policyResult && !policyResult.allowed) {
          res.status(403).json({
            error: 'Action blocked by policy even after approval.',
            reason: policyResult.reason ?? 'Policy check failed',
            requestId,
          });
          return;
        }

        // Inject OAuth token if available
        const tokenRow = await oauthRepository.getToken(body.userId, 'google');
        if (tokenRow) {
          candidateAction.parameters['accessToken'] = tokenRow.access_token;
        }

        // Build risk assessment for routing (user-approved = lower risk, but real assessment)
        const approvedDim: DimensionAssessment = { tier: RiskTier.LOW, score: 0.2, reasoning: 'User-approved action' };
        const riskAssessment: RiskAssessment = {
          actionId: candidateAction.id,
          overallTier: RiskTier.LOW,
          dimensions: {
            [RiskDimension.REVERSIBILITY]: approvedDim,
            [RiskDimension.FINANCIAL_IMPACT]: approvedDim,
            [RiskDimension.LEGAL_SENSITIVITY]: approvedDim,
            [RiskDimension.PRIVACY_SENSITIVITY]: approvedDim,
            [RiskDimension.RELATIONSHIP_SENSITIVITY]: approvedDim,
            [RiskDimension.OPERATIONAL_RISK]: approvedDim,
          },
          reasoning: 'Action was explicitly approved by user, policy checks passed',
          assessedAt: new Date(),
        };

        try {
          const executionRouter = await getRouter();
          // Approved-execution path: a human moved this through the approval
          // flow (and, for dual-confirmation actions, clicked twice — the
          // confirm-token check above enforces the count). Pass
          // `{ approved: true }` so the router's injection-guard backstop
          // lets the action through; the human already supplied the
          // confirmation the guard demanded.
          const result = await executionRouter.executeWithRouting(
            candidateAction,
            riskAssessment,
            body.userId,
            { approved: true },
          );

          // Persist execution plan + result atomically
          const savedPlan = await withTransaction(async (client) => {
            const planResult = await client.query(
              `INSERT INTO execution_plans (id, decision_id, action_id, status, steps, created_at)
               VALUES (gen_random_uuid(), $1, NULL, $2, $3, now())
               RETURNING *`,
              [
                approval.decision_id,
                result.status === 'completed' ? 'completed' : 'failed',
                JSON.stringify(result.output?.['stepsCompleted']
                  ? [{ type: candidateAction.actionType, status: result.status }]
                  : []),
              ],
            );
            const plan = planResult.rows[0];
            if (!plan) throw new Error('Failed to persist execution plan');

            await client.query(
              `INSERT INTO execution_results (id, plan_id, success, outputs, error, rollback_available, completed_at)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
              [
                plan.id,
                result.status === 'completed',
                JSON.stringify(result.output ?? {}),
                result.error ?? null,
                candidateAction.reversible,
              ],
            );

            return plan;
          });

          executionResult = {
            status: result.status,
            planId: savedPlan.id,
            adapterUsed: result.output?.['adapter_used'] ?? 'unknown',
          };
        } catch (execError) {
          // Execution failed after approval was recorded. Log the failure and persist
          // a failed plan so the approval isn't silently orphaned with no execution record.
          const errMsg = execError instanceof Error ? execError.message : String(execError);
          log.error(`Execution failed for approval ${requestId}`, { error: errMsg, stack: execError instanceof Error ? execError.stack : undefined });

          try {
            const failedPlan = await withTransaction(async (client) => {
              const planResult = await client.query(
                `INSERT INTO execution_plans (id, decision_id, action_id, status, steps, created_at)
                 VALUES (gen_random_uuid(), $1, NULL, 'failed', $2, now())
                 RETURNING *`,
                [approval.decision_id, JSON.stringify([{ type: candidateAction.actionType, status: 'error' }])],
              );
              const plan = planResult.rows[0];
              if (!plan) throw new Error('Failed to persist failed execution plan');
              await client.query(
                `INSERT INTO execution_results (id, plan_id, success, outputs, error, rollback_available, completed_at)
                 VALUES (gen_random_uuid(), $1, false, '{}', $2, $3, now())`,
                [plan.id, errMsg, candidateAction.reversible],
              );
              return plan;
            });

            executionResult = { status: 'failed', planId: failedPlan.id, error: 'Execution failed' };
          } catch (persistError) {
            log.error('Failed to persist execution failure record', { error: persistError instanceof Error ? persistError.message : String(persistError), stack: persistError instanceof Error ? persistError.stack : undefined });
            executionResult = { status: 'failed', error: 'Execution failed' };
          }
        } finally {
          // Always strip sensitive credentials, even on error paths
          delete candidateAction.parameters['accessToken'];
        }
      }

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
