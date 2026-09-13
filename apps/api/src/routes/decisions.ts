import { Router } from 'express';
import { decisionRepository, explanationRepository, inferenceReceiptRepository } from '@skytwin/db';
import { snapshotInferenceReceipt, verifyInferenceReceiptSeal } from '@skytwin/shared-types';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';

/**
 * Create the decisions query router.
 */
export function createDecisionsRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);

  /**
   * GET /api/decisions/:userId
   *
   * List decisions for a user with optional filtering.
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const domain = req.query['domain'] as string | undefined;
      const limit = Math.min(Math.max(parseInt(req.query['limit'] as string ?? '50', 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query['offset'] as string ?? '0', 10) || 0, 0);
      const from = req.query['from'] ? new Date(req.query['from'] as string) : undefined;
      const to = req.query['to'] ? new Date(req.query['to'] as string) : undefined;
      const situationType = req.query['situationType'] as string | undefined;
      const search = req.query['search'] as string | undefined;
      const signalId = (req.query['signalId'] ?? req.query['signal']) as string | undefined;

      let decisions = await decisionRepository.findByUser(userId, {
        domain,
        limit: search || situationType ? 500 : limit, // fetch more for client-side filters
        offset: search || situationType ? 0 : offset,
        from,
        to,
        signalId,
      });

      // Server-side filter: situation type
      if (situationType) {
        decisions = decisions.filter((d) => d.situation_type === situationType);
      }

      // Server-side filter: text search across situation type, domain
      if (search) {
        const q = search.toLowerCase();
        decisions = decisions.filter((d) =>
          d.situation_type?.toLowerCase().includes(q) ||
          d.domain?.toLowerCase().includes(q) ||
          d.urgency?.toLowerCase().includes(q),
        );
      }

      // Apply pagination after filters
      const total = decisions.length;
      if (search || situationType) {
        decisions = decisions.slice(offset, offset + limit);
      }

      // Batch-fetch outcomes in a single query (avoids N+1)
      const outcomes = await decisionRepository.getOutcomesForDecisions(
        decisions.map((d) => d.id),
      );
      const outcomeMap = new Map(
        outcomes.map((o) => [o.decision_id, o]),
      );

      res.json({
        decisions: decisions.map((d) => {
          const outcome = outcomeMap.get(d.id);
          return {
            id: d.id,
            situationType: d.situation_type,
            domain: d.domain,
            urgency: d.urgency,
            summary: typeof d.interpreted_situation?.['summary'] === 'string'
              ? d.interpreted_situation['summary']
              : null,
            autoExecuted: outcome ? outcome.auto_executed : null,
            requiresApproval: outcome ? outcome.requires_approval === true : false,
            createdAt: d.created_at,
          };
        }),
        total,
        limit,
        offset,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/decisions/:decisionId/explanation
   *
   * Get the explanation for a specific decision.
   */
  router.get('/:decisionId/explanation', async (req, res, next) => {
    try {
      const { decisionId } = req.params;
      if (!decisionId) {
        res.status(400).json({ error: 'Missing decisionId parameter' });
        return;
      }

      const decision = await decisionRepository.findById(decisionId);
      if (!decision) {
        res.status(404).json({ error: 'Decision not found' });
        return;
      }
      if (
        req.authenticatedUserId !== undefined &&
        decision.user_id !== req.authenticatedUserId
      ) {
        res.status(403).json({ error: 'You do not have access to this decision' });
        return;
      }

      const explanation = await explanationRepository.findByDecision(decisionId);

      if (!explanation) {
        res.status(404).json({ error: 'Explanation not found for this decision' });
        return;
      }

      res.json({
        explanation: {
          id: explanation.id,
          decisionId: explanation.decision_id,
          whatHappened: explanation.what_happened,
          confidenceReasoning: explanation.confidence_reasoning,
          actionRationale: explanation.action_rationale,
          escalationRationale: explanation.escalation_rationale,
          correctionGuidance: explanation.correction_guidance,
          createdAt: explanation.created_at,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /** Metadata-only receipt. Exact inference bytes are never returned here. */
  router.get('/:decisionId/receipt', async (req, res, next) => {
    try {
      const userId = req.authenticatedUserId;
      const decisionId = req.params['decisionId'];
      if (!userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (!decisionId) {
        res.status(400).json({ error: 'Missing decisionId parameter' });
        return;
      }
      const row = await inferenceReceiptRepository.findByDecisionForUser(userId, decisionId);
      if (!row) {
        res.status(404).json({ error: 'Inference receipt not found' });
        return;
      }
      const receipt = snapshotInferenceReceipt(row.receipt);
      if (!receipt || !verifyInferenceReceiptSeal(receipt) || receipt.id !== row.id ||
          receipt.version !== row.version || receipt.userId !== userId ||
          receipt.decisionId !== row.decision_id || receipt.decisionId !== decisionId ||
          receipt.explanationId !== row.explanation_id || receipt.status !== row.status) {
        res.status(409).json({ error: 'Stored inference receipt failed integrity validation' });
        return;
      }
      res.json({
        receipt,
        persistenceTrust: row.trusted === true ? 'trusted' : 'imported_unverified',
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:decisionId/receipt', async (req, res, next) => {
    try {
      const userId = req.authenticatedUserId;
      const decisionId = req.params['decisionId'];
      if (!userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (!decisionId) {
        res.status(400).json({ error: 'Missing decisionId parameter' });
        return;
      }
      const deleted = await inferenceReceiptRepository.deleteByDecisionForUser(userId, decisionId);
      if (!deleted) {
        res.status(404).json({ error: 'Inference receipt not found' });
        return;
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
