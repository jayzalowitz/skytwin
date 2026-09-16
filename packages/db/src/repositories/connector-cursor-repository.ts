import { query } from '../connection.js';

export interface ConnectorCursorRow {
  id: string;
  user_id: string;
  connector_account_id: string | null;
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
      `SELECT id, user_id, connector_account_id, provider, cursor_kind, cursor_value, updated_at
         FROM connector_cursors
        WHERE user_id = $1 AND provider = $2 AND cursor_kind = $3
          AND connector_account_id IS NULL`,
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
       ON CONFLICT (user_id, provider, cursor_kind)
         WHERE connector_account_id IS NULL
       DO UPDATE SET
         cursor_value = EXCLUDED.cursor_value,
         updated_at = now()
       RETURNING id, user_id, connector_account_id, provider, cursor_kind, cursor_value, updated_at`,
      [userId, provider, cursorKind, cursorValue],
    );
    return result.rows[0]!;
  },

  /** Account-bound cursor used by Gmail. The active ownership join is the boundary. */
  async getForAccount(
    userId: string,
    connectorAccountId: string,
    provider: string,
    cursorKind: string,
  ): Promise<ConnectorCursorRow | null> {
    const result = await query<ConnectorCursorRow>(
      `SELECT c.* FROM connector_cursors AS c
       JOIN connected_accounts AS ca
         ON ca.id = c.connector_account_id AND ca.user_id = c.user_id
       WHERE c.user_id = $1 AND c.connector_account_id = $2
         AND c.provider = $3 AND c.cursor_kind = $4
         AND ca.is_active = true AND ca.identity_verified = true`,
      [userId, connectorAccountId, provider, cursorKind],
    );
    return result.rows[0] ?? null;
  },

  async saveForAccount(
    userId: string,
    connectorAccountId: string,
    provider: string,
    cursorKind: string,
    cursorValue: string,
  ): Promise<ConnectorCursorRow | null> {
    const result = await query<ConnectorCursorRow>(
      `INSERT INTO connector_cursors (
         user_id, connector_account_id, provider, cursor_kind, cursor_value
       )
       SELECT $1, ca.id, $3, $4, $5
         FROM connected_accounts AS ca
        WHERE ca.id = $2 AND ca.user_id = $1 AND ca.is_active = true
          AND ca.identity_verified = true
       ON CONFLICT (connector_account_id, provider, cursor_kind)
         WHERE connector_account_id IS NOT NULL
       DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()
       RETURNING *`,
      [userId, connectorAccountId, provider, cursorKind, cursorValue],
    );
    return result.rows[0] ?? null;
  },

  async deleteForAccount(
    userId: string,
    connectorAccountId: string,
    provider: string,
    cursorKind: string,
  ): Promise<boolean> {
    const result = await query(
      `DELETE FROM connector_cursors
        WHERE user_id = $1 AND connector_account_id = $2
          AND provider = $3 AND cursor_kind = $4`,
      [userId, connectorAccountId, provider, cursorKind],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /** Drop a cursor (e.g. when the user disconnects the provider). */
  async delete(
    userId: string,
    provider: string,
    cursorKind: string,
  ): Promise<boolean> {
    const result = await query(
      `DELETE FROM connector_cursors
        WHERE user_id = $1 AND provider = $2 AND cursor_kind = $3
          AND connector_account_id IS NULL`,
      [userId, provider, cursorKind],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
