import { Router } from 'express';
import {
  approvalRepository,
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
  const executionRouter = getExecutionRouter();

  /**
   * GET /api/approvals/:userId/pending
   *
   * List pending approval requests for a user.
   */
  router.get('/:userId/pending', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const approvals = await approvalRepository.findPending(userId);

      res.json({
        approvals: approvals.map((a) => ({
          id: a.id,
          decisionId: a.decision_id,
          candidateAction: a.candidate_action,
          reason: a.reason,
          urgency: a.urgency,
          status: a.status,
          requestedAt: a.requested_at,
        })),
      });
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
      const limit = parseInt(req.query['limit'] as string ?? '50', 10);
      const approvals = await approvalRepository.findByUser(userId, limit);

      res.json({
        approvals: approvals.map((a) => ({
          id: a.id,
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
      const approval = await approvalRepository.respond(requestId, body.action, body.reason);
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
      let executionResult = null;
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
          const plan = planResult.rows[0]!;

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
   * POST /api/approvals/expire-sweep
   *
   * Manually trigger expiry of stale pending approvals.
   */
  router.post('/expire-sweep', async (_req, res, next) => {
    try {
      const count = await approvalRepository.expirePending();
      res.json({ expired: count });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
