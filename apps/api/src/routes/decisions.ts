import { Router } from 'express';
import { decisionRepository, explanationRepository } from '@skytwin/db';

/**
 * Create the decisions query router.
 */
export function createDecisionsRouter(): Router {
  const router = Router();

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
      const limit = parseInt(req.query['limit'] as string ?? '50', 10);
      const offset = parseInt(req.query['offset'] as string ?? '0', 10);

      const decisions = await decisionRepository.findByUser(userId, {
        domain,
        limit,
        offset,
      });

      res.json({
        decisions: decisions.map((d) => ({
          id: d.id,
          situationType: d.situation_type,
          domain: d.domain,
          urgency: d.urgency,
          createdAt: d.created_at,
        })),
        total: decisions.length,
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

  return router;
}
