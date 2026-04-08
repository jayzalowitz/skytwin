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
      const from = req.query['from'] ? new Date(req.query['from'] as string) : undefined;
      const to = req.query['to'] ? new Date(req.query['to'] as string) : undefined;
      const situationType = req.query['situationType'] as string | undefined;
      const search = req.query['search'] as string | undefined;

      let decisions = await decisionRepository.findByUser(userId, {
        domain,
        limit: search || situationType ? 500 : limit, // fetch more for client-side filters
        offset: search || situationType ? 0 : offset,
        from,
        to,
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

      // Batch-fetch outcomes to get auto_executed status
      const outcomeMap = new Map<string, boolean>();
      await Promise.all(
        decisions.map(async (d) => {
          const outcome = await decisionRepository.getOutcome(d.id);
          if (outcome) {
            outcomeMap.set(d.id, outcome.auto_executed);
          }
        }),
      );

      res.json({
        decisions: decisions.map((d) => ({
          id: d.id,
          situationType: d.situation_type,
          domain: d.domain,
          urgency: d.urgency,
          autoExecuted: outcomeMap.get(d.id) ?? false,
          createdAt: d.created_at,
        })),
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
