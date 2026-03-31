import { Router } from 'express';
import { feedbackRepository, twinRepository, patternRepository } from '@skytwin/db';
import { TwinService } from '@skytwin/twin-model';
import type { FeedbackEvent } from '@skytwin/shared-types';

/**
 * Map route-level feedback types to the FeedbackEvent feedbackType union.
 */
function mapFeedbackType(
  routeType: string,
): FeedbackEvent['feedbackType'] {
  switch (routeType) {
    case 'approve':
    case 'reward':
      return 'approve';
    case 'reject':
    case 'punish':
      return 'reject';
    case 'edit':
    case 'undo':
    case 'restate_preference':
      return 'correct';
    default:
      return 'ignore';
  }
}

/**
 * Create the feedback submission router.
 */
export function createFeedbackRouter(): Router {
  const router = Router();
  const twinService = new TwinService(twinRepository as never, patternRepository as never);

  /**
   * POST /api/feedback
   *
   * Submit feedback about a decision and update the twin model.
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

      // 1. Persist raw feedback event
      const savedFeedback = await feedbackRepository.create({
        userId: body.userId,
        decisionId: body.decisionId,
        type: body.type,
        data: body.data ?? {},
      });

      // 2. Build a FeedbackEvent for the twin model
      const feedbackEvent: FeedbackEvent = {
        id: savedFeedback.id,
        userId: body.userId,
        decisionId: body.decisionId,
        feedbackType: mapFeedbackType(body.type),
        correctedAction: body.data?.['correctedAction'] as string | undefined,
        correctedValue: body.data?.['correctedValue'],
        reason: body.data?.['reason'] as string | undefined,
        timestamp: new Date(),
      };

      // 3. Update the twin model — this is the critical feedback loop
      const updatedProfile = await twinService.processFeedback(
        body.userId,
        feedbackEvent,
      );

      res.status(201).json({
        feedback: {
          id: savedFeedback.id,
          userId: savedFeedback.user_id,
          decisionId: savedFeedback.decision_id,
          type: savedFeedback.type,
          createdAt: savedFeedback.created_at,
        },
        twinProfileVersion: updatedProfile.version,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
