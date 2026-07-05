import { query } from '../connection.js';
import type { RoutineActionKind } from '@skytwin/shared-types';

/**
 * Repository for `watch_runs` — the canonical record of each Watch firing
 * (#519 part 3b). See migration 070-watch-runs. The ambient surfaces (briefing
 * projection, notifications) read from here; it is the single source of truth.
 */

export interface WatchRunRow {
  id: string;
  watch_id: string;
  user_id: string;
  ran_at: Date;
  // `action` is CHECK-constrained to digest/notify and `matched_refs` is
  // NOT NULL DEFAULT '[]' in migration 070 — mirror those guarantees here so
  // downstream readers don't null-guard a column the table forbids being null.
  action: RoutineActionKind;
  matched_count: number;
  summary: string;
  matched_refs: string[];
}

export interface CreateWatchRunInput {
  watchId: string;
  userId: string;
  action: RoutineActionKind;
  matchedCount: number;
  summary: string;
  /** Signal ids/refs that matched — the firing's evidence. */
  matchedRefs: string[];
}

export const watchRunRepository = {
  async create(input: CreateWatchRunInput): Promise<WatchRunRow> {
    const result = await query<WatchRunRow>(
      `INSERT INTO watch_runs (watch_id, user_id, action, matched_count, summary, matched_refs)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.watchId,
        input.userId,
        input.action,
        input.matchedCount,
        input.summary,
        JSON.stringify(input.matchedRefs),
      ],
    );
    return result.rows[0]!;
  },

  /** A watch's recent runs, newest first (for the Watches page). Ownership-scoped. */
  async listForWatch(watchId: string, userId: string, limit = 20): Promise<WatchRunRow[]> {
    const result = await query<WatchRunRow>(
      `SELECT * FROM watch_runs
        WHERE watch_id = $1 AND user_id = $2
        ORDER BY ran_at DESC
        LIMIT $3`,
      [watchId, userId, limit],
    );
    return result.rows;
  },

  /** A user's recent runs across all their watches (for the briefing projection). */
  async listRecentForUser(userId: string, since: Date, limit = 50): Promise<WatchRunRow[]> {
    const result = await query<WatchRunRow>(
      `SELECT * FROM watch_runs
        WHERE user_id = $1 AND ran_at >= $2
        ORDER BY ran_at DESC
        LIMIT $3`,
      [userId, since, limit],
    );
    return result.rows;
  },
};
