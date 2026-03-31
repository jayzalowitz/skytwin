import { Router } from 'express';
import { feedbackRepository } from '@skytwin/db';

/**
 * Create the feedback submission router.
 */
export function createFeedbackRouter(): Router {
  const router = Router();

  /**
   * POST /api/feedback
   *
   * Submit feedback about a decision.
   */
  router.post('/', async (req, res, next) => {
    try {
      const body = req.body as {
        userId: string;
        decisionId: string;
        type: string;
        data?: Record<string, unknown>;
      };

      if (!body.userId || !body.decisionId || !body.type) {
        res.status(400).json({
          error: 'Missing required fields: userId, decisionId, type',
        });
        return;
      }

      const validTypes = ['approve', 'reject', 'edit', 'undo', 'restate_preference', 'reward', 'punish'];
      if (!validTypes.includes(body.type)) {
        res.status(400).json({
          error: `Invalid feedback type. Must be one of: ${validTypes.join(', ')}`,
        });
        return;
      }

      const feedbackEvent = await feedbackRepository.create({
        userId: body.userId,
        decisionId: body.decisionId,
        type: body.type,
        data: body.data ?? {},
      });

      res.status(201).json({
        feedback: {
          id: feedbackEvent.id,
          userId: feedbackEvent.user_id,
          decisionId: feedbackEvent.decision_id,
          type: feedbackEvent.type,
          createdAt: feedbackEvent.created_at,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
