import { query } from '../connection.js';

export type LifebookImportance = 'core' | 'secondary' | 'emerging';

export interface LifebookRow {
  id: string;
  user_id: string;
  domain_name: string;
  importance: LifebookImportance;
  sample_signals: string[];
  suggested_capabilities: string[];
  wing_id: string | null;
  detected_at: Date;
  last_seen_at: Date;
  hidden_at: Date | null;
}

export interface UpsertLifebookInput {
  userId: string;
  domainName: string;
  importance: LifebookImportance;
  sampleSignals: string[];
  suggestedCapabilities: string[];
  wingId: string | null;
}

/**
 * Repository for `lifebooks` (#193 Child 1).
 *
 * The domain-extractor worker upserts one row per detected life domain
 * per user. Hidden rows survive — re-running extraction must not bring
 * them back. Only user-initiated `unhide` clears `hidden_at`.
 */
export const lifebookRepository = {
  /**
   * Upsert a lifebook by (user_id, domain_name).
   *
   * If a row already exists, updates importance, sample signals, suggested
   * capabilities, wing pointer, and `last_seen_at` — but never touches
   * `hidden_at`. This means a user who hid a domain stays hidden across
   * re-extraction.
   */
  async upsert(input: UpsertLifebookInput): Promise<LifebookRow> {
    const result = await query<LifebookRow>(
      `INSERT INTO lifebooks
         (user_id, domain_name, importance, sample_signals, suggested_capabilities, wing_id, last_seen_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now())
       ON CONFLICT (user_id, domain_name) DO UPDATE SET
         importance = EXCLUDED.importance,
         sample_signals = EXCLUDED.sample_signals,
         suggested_capabilities = EXCLUDED.suggested_capabilities,
         wing_id = COALESCE(EXCLUDED.wing_id, lifebooks.wing_id),
         last_seen_at = EXCLUDED.last_seen_at
       RETURNING *`,
      [
        input.userId,
        input.domainName,
        input.importance,
        JSON.stringify(input.sampleSignals),
        JSON.stringify(input.suggestedCapabilities),
        input.wingId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('lifebook upsert returned no row');
    return row;
  },

  /**
   * List visible lifebooks (hidden_at IS NULL) for a user, ordered
   * core → secondary → emerging, then most-recently-seen first.
   */
  async listVisible(userId: string): Promise<LifebookRow[]> {
    const result = await query<LifebookRow>(
      `SELECT * FROM lifebooks
       WHERE user_id = $1 AND hidden_at IS NULL
       ORDER BY
         CASE importance WHEN 'core' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,
         last_seen_at DESC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * List all lifebooks (including hidden) for a user. Used by the
   * Settings → Lifebooks management UX so the user can unhide.
   */
  async listAll(userId: string): Promise<LifebookRow[]> {
    const result = await query<LifebookRow>(
      `SELECT * FROM lifebooks
       WHERE user_id = $1
       ORDER BY last_seen_at DESC`,
      [userId],
    );
    return result.rows;
  },

  async findByDomain(userId: string, domainName: string): Promise<LifebookRow | null> {
    const result = await query<LifebookRow>(
      `SELECT * FROM lifebooks
       WHERE user_id = $1 AND domain_name = $2
       LIMIT 1`,
      [userId, domainName],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Hide a lifebook from dashboards. The row is preserved so the wing
   * and its memories remain — only the surface visibility changes.
   */
  async hide(userId: string, domainName: string): Promise<boolean> {
    const result = await query(
      `UPDATE lifebooks
       SET hidden_at = now()
       WHERE user_id = $1 AND domain_name = $2 AND hidden_at IS NULL`,
      [userId, domainName],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Unhide a previously hidden lifebook. Idempotent.
   */
  async unhide(userId: string, domainName: string): Promise<boolean> {
    const result = await query(
      `UPDATE lifebooks
       SET hidden_at = NULL
       WHERE user_id = $1 AND domain_name = $2 AND hidden_at IS NOT NULL`,
      [userId, domainName],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
