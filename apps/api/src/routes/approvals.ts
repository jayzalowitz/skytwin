import { Router } from 'express';
import { decisionRepository } from '@skytwin/db';

/**
 * Create the approvals handling router.
 */
export function createApprovalsRouter(): Router {
  const router = Router();

  /**
   * POST /api/approvals/:requestId/respond
   *
   * Approve or reject an approval request.
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

      // Look up the decision associated with this approval request
      const decision = await decisionRepository.findById(requestId);
      if (!decision) {
        res.status(404).json({ error: 'Approval request not found' });
        return;
      }

      const outcome = await decisionRepository.getOutcome(requestId);

      res.json({
        requestId,
        action: body.action,
        reason: body.reason ?? null,
        decision: decision ? {
          id: decision.id,
          domain: decision.domain,
          situationType: decision.situation_type,
        } : null,
        outcome: outcome ? {
          autoExecuted: outcome.auto_executed,
          requiresApproval: outcome.requires_approval,
        } : null,
        processedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
