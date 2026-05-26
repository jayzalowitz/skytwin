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
   * Append a single access-log row. Fire-and-forget friendly — the
   * caller can safely ignore the returned promise if it's instrumenting
   * a hot path (the audit log should never block or fail a legitimate
   * access, just record it). Errors should be caught and logged at
   * the call site so a CRDB blip doesn't take down the credential
   * vault decrypt path.
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
   */
  async findByUser(
    userId: string,
    opts: { limit?: number } = {},
  ): Promise<AccessLogRow[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
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
