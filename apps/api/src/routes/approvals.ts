import { Router } from 'express';
import {
  approvalRepository,
  feedbackRepository,
  oauthRepository,
  executionRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
} from '@skytwin/db';
import { TwinService } from '@skytwin/twin-model';
import {
  BasicMockAdapter,
  RealIronClawAdapter,
  ActionHandlerRegistry,
  EmailActionHandler,
  CalendarActionHandler,
  GenericActionHandler,
} from '@skytwin/ironclaw-adapter';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import { loadConfig } from '@skytwin/config';
import type { FeedbackEvent, CandidateAction } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

/**
 * Create the approvals handling router.
 */
export function createApprovalsRouter(): Router {
  const router = Router();
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());

  const config = loadConfig();
  let ironclawAdapter: IronClawAdapter;
  if (config.useMockIronclaw) {
    ironclawAdapter = new BasicMockAdapter();
  } else {
    const registry = new ActionHandlerRegistry();
    registry.register(new EmailActionHandler());
    registry.register(new CalendarActionHandler());
    registry.register(new GenericActionHandler());
    ironclawAdapter = new RealIronClawAdapter(registry);
  }

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

      // Update the approval request
      const approval = await approvalRepository.respond(requestId, body.action, body.reason);
      if (!approval) {
        res.status(404).json({ error: 'Approval request not found' });
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

      // If approved, execute the action via IronClaw
      let executionResult = null;
      if (body.action === 'approve') {
        const storedAction = approval.candidate_action as Record<string, unknown>;
        const candidateAction: CandidateAction = {
          id: `action_${approval.id}`,
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

        // Inject OAuth token if available
        const tokenRow = await oauthRepository.getToken(body.userId, 'google');
        if (tokenRow) {
          candidateAction.parameters['accessToken'] = tokenRow.access_token;
        }

        const plan = await ironclawAdapter.buildPlan(candidateAction);
        const result = await ironclawAdapter.execute(plan);

        // Persist execution
        const savedPlan = await executionRepository.createPlan({
          decisionId: approval.decision_id,
          actionId: candidateAction.id,
          status: result.status === 'completed' ? 'completed' : 'failed',
          steps: plan.steps ?? [],
        });
        await executionRepository.createResult({
          planId: savedPlan.id,
          success: result.status === 'completed',
          outputs: result.output ?? {},
          error: result.error ?? undefined,
          rollbackAvailable: candidateAction.reversible,
        });

        executionResult = {
          status: result.status,
          planId: savedPlan.id,
        };
      }

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

  return router;
}
