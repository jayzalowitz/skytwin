import { Router } from 'express';
import { feedbackRepository, twinRepository, patternRepository } from '@skytwin/db';
import { TwinService } from '@skytwin/twin-model';
import type { FeedbackEvent, UndoReasoning } from '@skytwin/shared-types';

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
    case 'undo':
      return 'undo';
    case 'edit':
    case 'restate_preference':
      return 'correct';
    default:
      return 'ignore';
  }
}

const VALID_SEVERITIES = new Set(['minor', 'moderate', 'severe']);

/**
 * Validate and narrow an unknown payload into UndoReasoning.
 * Returns the validated object or null if invalid.
 */
function parseUndoReasoning(raw: unknown): UndoReasoning | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj['whatWentWrong'] !== 'string' || obj['whatWentWrong'].length === 0) {
    return null;
  }
  if (!VALID_SEVERITIES.has(obj['severity'] as string)) {
    return null;
  }

  const reasoning: UndoReasoning = {
    whatWentWrong: obj['whatWentWrong'] as string,
    severity: obj['severity'] as UndoReasoning['severity'],
  };

  if (typeof obj['whichStep'] === 'string' && obj['whichStep'].length > 0) {
    reasoning.whichStep = obj['whichStep'];
  }
  if (typeof obj['preferredAlternative'] === 'string' && obj['preferredAlternative'].length > 0) {
    reasoning.preferredAlternative = obj['preferredAlternative'];
  }

  return reasoning;
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
   *
   * For undo feedback, the body should include an `undoReasoning` object:
   * ```json
   * {
   *   "userId": "...",
   *   "decisionId": "...",
   *   "type": "undo",
   *   "undoReasoning": {
   *     "whatWentWrong": "...",
   *     "whichStep": "...",
   *     "preferredAlternative": "...",
   *     "severity": "minor|moderate|severe"
   *   }
   * }
   * ```
   */
  router.post('/', async (req, res, next) => {
    try {
      const body = req.body as {
        userId: string;
        decisionId: string;
        type: string;
        data?: Record<string, unknown>;
        undoReasoning?: unknown;
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

      // Parse undoReasoning when feedback type is 'undo' (optional for API compat)
      let undoReasoning: UndoReasoning | undefined;
      if (body.type === 'undo' && body.undoReasoning !== undefined) {
        const parsed = parseUndoReasoning(body.undoReasoning);
        if (!parsed) {
          res.status(400).json({
            error:
              'undoReasoning, if provided, must include ' +
              'whatWentWrong (string) and severity (minor|moderate|severe).',
          });
          return;
        }
        undoReasoning = parsed;
      }

      // 1. Persist raw feedback event
      const savedFeedback = await feedbackRepository.create({
        userId: body.userId,
        decisionId: body.decisionId,
        type: body.type,
        data: {
          ...(body.data ?? {}),
          ...(undoReasoning ? { undoReasoning } : {}),
        },
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
        undoReasoning,
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
