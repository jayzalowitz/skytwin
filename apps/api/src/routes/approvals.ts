import { Router } from 'express';
import {
  approvalRepository,
  decisionRepository,
  feedbackRepository,
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
import { sseManager } from '../sse.js';

/**
 * Create the approvals handling router.
 */
export function createApprovalsRouter(): Router {
  const router = Router();
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
          const result = await executionRouter.executeWithRouting(
            candidateAction,
            riskAssessment,
            body.userId,
          );

          // Persist execution plan + result atomically
          const savedPlan = await withTransaction(async (client) => {
            const planResult = await client.query(
              `INSERT INTO execution_plans (id, decision_id, status, steps, created_at)
               VALUES (gen_random_uuid(), $1, $2, $3, now())
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
              `INSERT INTO execution_results (id, plan_id, success, outputs, error, rollback_available, created_at)
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
          console.error(`[approvals] Execution failed for approval ${requestId}:`, errMsg);

          try {
            const failedPlan = await withTransaction(async (client) => {
              const planResult = await client.query(
                `INSERT INTO execution_plans (id, decision_id, status, steps, created_at)
                 VALUES (gen_random_uuid(), $1, 'failed', $2, now())
                 RETURNING *`,
                [approval.decision_id, JSON.stringify([{ type: candidateAction.actionType, status: 'error' }])],
              );
              const plan = planResult.rows[0];
              if (!plan) throw new Error('Failed to persist failed execution plan');
              await client.query(
                `INSERT INTO execution_results (id, plan_id, success, outputs, error, rollback_available, created_at)
                 VALUES (gen_random_uuid(), $1, false, '{}', $2, $3, now())`,
                [plan.id, errMsg, candidateAction.reversible],
              );
              return plan;
            });

            executionResult = { status: 'failed', planId: failedPlan.id, error: 'Execution failed' };
          } catch (persistError) {
            console.error('[approvals] Failed to persist execution failure record:', persistError);
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
