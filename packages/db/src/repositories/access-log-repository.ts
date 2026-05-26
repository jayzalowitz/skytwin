import { query } from '../connection.js';

/**
 * One audit-log row recording a single sensitive-data access (#393).
 *
 * See migration 062-access-log.sql for the schema rationale. Rows
 * are append-only — there is no `update` method. A user-driven purge
 * (#376) drops the user's audit history alongside everything else
 * via the ON DELETE CASCADE on `user_id`.
 */
export interface AccessLogRow {
  id: string;
  user_id: string;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  occurred_at: Date;
}

export interface RecordAccessInput {
  userId: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string | null;
}

export const accessLogRepository = {
  /**
   * Append a single access-log row.
   *
   * Returns a rejecting promise on failure — callers MUST either await
   * + catch, or wrap the call in `.catch()` to avoid an unhandled
   * rejection (an unhandled rejection on a hot decrypt path would emit
   * a process-wide warning AND, on newer Node, can crash the worker).
   * The convention in `db-token-store.ts` is the pattern to mirror:
   * call inside a try/catch and `.catch()` the returned promise.
   *
   * "Fire-and-forget" in this codebase means "swallowed at the call
   * site," not "the repo handles it for you." The repo is intentionally
   * thin so a future caller that DOES want to fail-loud on audit-log
   * failure (e.g. an enterprise compliance hook) isn't forced into
   * silent semantics it can't opt out of.
   */
  async record(input: RecordAccessInput): Promise<void> {
    await query(
      `INSERT INTO access_log
         (user_id, actor, action, resource_type, resource_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.userId,
        input.actor,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.requestId ?? null,
      ],
    );
  },

  /**
   * Read the user's own audit history, newest first. Backs the future
   * Settings → "Access log" page (#393 follow-up). The
   * `(user_id, occurred_at DESC)` index from migration 062 keeps this
   * cheap as the table grows.
   *
   * `limit` is sanitised against NaN / non-integer / negative inputs
   * before being interpolated into the SQL — a malformed query param
   * propagated from the future Settings endpoint must NEVER reach
   * CRDB as an invalid `LIMIT` token.
   */
  async findByUser(
    userId: string,
    opts: { limit?: number } = {},
  ): Promise<AccessLogRow[]> {
    const limit = sanitiseLimit(opts.limit, 100);
    const result = await query<AccessLogRow>(
      `SELECT id, user_id, actor, action, resource_type, resource_id, request_id, occurred_at
         FROM access_log
        WHERE user_id = $1
        ORDER BY occurred_at DESC
        LIMIT ${limit}`,
      [userId],
    );
    return result.rows;
  },
};

/**
 * Clamp + integer-coerce a caller-supplied limit. NaN and undefined
 * fall through to `defaultValue`; ±Infinity get clamped to the
 * `[1, 1000]` range like any out-of-bounds finite value. A malformed
 * limit must NEVER become `LIMIT NaN` / `LIMIT 50.5` / `LIMIT Infinity`
 * in the emitted SQL.
 */
function sanitiseLimit(raw: number | undefined, defaultValue: number): number {
  if (raw === undefined || Number.isNaN(raw)) return defaultValue;
  if (raw === Number.POSITIVE_INFINITY) return 1000;
  if (raw === Number.NEGATIVE_INFINITY) return 1;
  return Math.max(1, Math.min(1000, Math.floor(raw)));
}
