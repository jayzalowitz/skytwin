import { Router } from 'express';
import type { SkillGap } from '@skytwin/shared-types';
import { skillGapRepository } from '@skytwin/db';
import type { SkillGapRow } from '@skytwin/db';

/**
 * Map a DB row to the SkillGap domain type.
 */
function toSkillGap(row: SkillGapRow): SkillGap {
  return {
    id: row.id,
    actionType: row.action_type,
    actionDescription: row.action_description,
    attemptedAdapters: row.attempted_adapters as string[],
    userId: row.user_id,
    decisionId: row.decision_id ?? undefined,
    ironclawIssueUrl: row.ironclaw_issue_url ?? undefined,
    loggedAt: row.logged_at,
  };
}

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
   */
  router.get('/', async (req, res, next) => {
    try {
      const limit = Math.min(
        Math.max(parseInt(req.query['limit'] as string, 10) || 50, 1),
        200,
      );
      const actionType = req.query['actionType'] as string | undefined;

      let rows;
      if (actionType) {
        rows = await skillGapRepository.getByActionType(actionType);
      } else {
        rows = await skillGapRepository.getAll(limit);
      }

      const skillGaps: SkillGap[] = rows.map(toSkillGap);

      res.json({ skillGaps, total: skillGaps.length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
