import { Router } from 'express';
import type { SkillGap } from '@skytwin/shared-types';

/**
 * Create the skill-gaps router.
 *
 * GET /skill-gaps — List all skill gaps with optional filtering.
 */
export function createSkillGapsRouter(): Router {
  const router = Router();

  /**
   * GET /api/v1/skill-gaps
   *
   * List all skill gaps.
   * Query params:
   *   ?limit=50       — Maximum number of results (default 50)
   *   ?actionType=... — Filter by action type
   *
   * Scaffold: returns an empty array.
   */
  router.get('/', async (_req, res, next) => {
    try {
      // Scaffold: return empty array (no persistence layer yet)
      const skillGaps: SkillGap[] = [];

      res.json({ skillGaps });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
