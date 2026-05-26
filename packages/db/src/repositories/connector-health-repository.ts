import { query } from '../connection.js';

/**
 * Snapshot of a single (user, connector) health row.
 *
 * `status` is a narrow string union enforced at the API boundary so
 * the dashboard banner can branch on a known set of values rather
 * than free text. `errorCode` is a short tag (e.g. `'invalid_grant'`)
 * surfaced for the "needs_reauth" banner copy. The two timestamps
 * are for debugging + a future "connector health" Settings card.
 */
export interface ConnectorHealthRow {
  user_id: string;
  connector_name: string;
  status: 'connected' | 'needs_reauth' | 'disabled';
  error_code: string | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  updated_at: Date;
}

/**
 * Backing repository for the OAuth re-auth user-facing surface (#377).
 *
 * The worker upserts on every poll outcome: `'needs_reauth'` on the
 * permanent-failure branch (`OAuthRefreshError.permanent === true`),
 * `'connected'` on success. A successful re-auth + subsequent poll
 * self-heals the row so the dashboard banner disappears without any
 * extra ceremony.
 *
 * One row per (user_id, connector_name). Not a timeseries — only
 * current state. See migration 060-connector-health.sql for the
 * full rationale + schema.
 */
export const connectorHealthRepository = {
  /**
   * Upsert the connector's current health snapshot. On 'connected'
   * the caller should pass `lastSuccessAt: new Date()`; on
   * 'needs_reauth' (or 'disabled'), `lastFailureAt`. The opposite
   * timestamp is preserved across the upsert so a flap doesn't
   * destroy the last-known-good marker.
   */
  async upsert(input: {
    userId: string;
    connectorName: string;
    status: ConnectorHealthRow['status'];
    errorCode?: string | null;
    lastSuccessAt?: Date | null;
    lastFailureAt?: Date | null;
  }): Promise<void> {
    const now = new Date();
    await query(
      `INSERT INTO connector_health (
         user_id, connector_name, status, error_code,
         last_success_at, last_failure_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, connector_name) DO UPDATE SET
         status = EXCLUDED.status,
         error_code = EXCLUDED.error_code,
         last_success_at = COALESCE(EXCLUDED.last_success_at, connector_health.last_success_at),
         last_failure_at = COALESCE(EXCLUDED.last_failure_at, connector_health.last_failure_at),
         updated_at = EXCLUDED.updated_at`,
      [
        input.userId,
        input.connectorName,
        input.status,
        input.errorCode ?? null,
        input.lastSuccessAt ?? null,
        input.lastFailureAt ?? null,
        now,
      ],
    );
  },

  /** Return every connector health row for a given user. */
  async findByUser(userId: string): Promise<ConnectorHealthRow[]> {
    const result = await query<ConnectorHealthRow>(
      `SELECT user_id, connector_name, status, error_code,
              last_success_at, last_failure_at, updated_at
         FROM connector_health
        WHERE user_id = $1
        ORDER BY connector_name`,
      [userId],
    );
    return result.rows;
  },
};
