import { query } from '../connection.js';

export interface ConnectorCursorRow {
  user_id: string;
  provider: string;
  cursor_kind: string;
  cursor_value: string;
  updated_at: Date;
}

/**
 * Per-user, per-provider cursor for incremental polling.
 *
 * Gmail uses `cursor_kind = 'history_id'` with the `users.history.list`
 * endpoint; Calendar will use `cursor_kind = 'sync_token'`. The schema is
 * deliberately generic so a new connector doesn't need a new table.
 *
 * Multi-account note: today we key on `(user_id, provider)`, which works
 * for the worker's current single-account-per-user model. When the
 * #101 follow-up wires per-account connectors, this keying will need to
 * gain `account_email` — same shape as oauth_tokens picked up in #103.
 */
export const connectorCursorRepository = {
  /** Get a cursor; returns null when none has been stored yet. */
  async get(
    userId: string,
    provider: string,
    cursorKind: string,
  ): Promise<ConnectorCursorRow | null> {
    const result = await query<ConnectorCursorRow>(
      `SELECT user_id, provider, cursor_kind, cursor_value, updated_at
         FROM connector_cursors
        WHERE user_id = $1 AND provider = $2 AND cursor_kind = $3`,
      [userId, provider, cursorKind],
    );
    return result.rows[0] ?? null;
  },

  /** Idempotent upsert — replaces the value for an existing cursor. */
  async save(
    userId: string,
    provider: string,
    cursorKind: string,
    cursorValue: string,
  ): Promise<ConnectorCursorRow> {
    const result = await query<ConnectorCursorRow>(
      `INSERT INTO connector_cursors (user_id, provider, cursor_kind, cursor_value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, provider, cursor_kind) DO UPDATE SET
         cursor_value = EXCLUDED.cursor_value,
         updated_at = now()
       RETURNING user_id, provider, cursor_kind, cursor_value, updated_at`,
      [userId, provider, cursorKind, cursorValue],
    );
    return result.rows[0]!;
  },

  /** Drop a cursor (e.g. when the user disconnects the provider). */
  async delete(
    userId: string,
    provider: string,
    cursorKind: string,
  ): Promise<boolean> {
    const result = await query(
      `DELETE FROM connector_cursors
        WHERE user_id = $1 AND provider = $2 AND cursor_kind = $3`,
      [userId, provider, cursorKind],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
