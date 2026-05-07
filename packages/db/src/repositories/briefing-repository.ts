import { query } from '../connection.js';

export interface TwinBriefingRow {
  id: string;
  user_id: string;
  cadence: 'daily' | 'weekly';
  generated_at: Date;
  prose_markdown: string;
  source_event_count: number;
  llm_provider: string | null;
  llm_cost_cents: number | null;
  read_at: Date | null;
}

export interface CreateTwinBriefingInput {
  userId: string;
  cadence: 'daily' | 'weekly';
  proseMarkdown: string;
  sourceEventCount: number;
  llmProvider?: string;
  llmCostCents?: number;
}

/**
 * Repository for twin_briefings (issue #177).
 *
 * Daily/weekly LLM-prose (or v1 templated-prose) briefings stored per user.
 * The table was created in migration 027-capability-acquisition.sql.
 */
export const briefingRepository = {
  /**
   * Insert a new briefing row.
   */
  async create(input: CreateTwinBriefingInput): Promise<TwinBriefingRow> {
    const result = await query<TwinBriefingRow>(
      `INSERT INTO twin_briefings
         (user_id, cadence, prose_markdown, source_event_count, llm_provider, llm_cost_cents)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.userId,
        input.cadence,
        input.proseMarkdown,
        input.sourceEventCount,
        input.llmProvider ?? null,
        input.llmCostCents ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('briefing insert returned no row');
    return row;
  },

  /**
   * Return the most recently generated briefing for a user, optionally
   * filtered by cadence.
   */
  async getLatestForUser(userId: string, cadence?: 'daily' | 'weekly'): Promise<TwinBriefingRow | null> {
    if (cadence) {
      const result = await query<TwinBriefingRow>(
        `SELECT * FROM twin_briefings
         WHERE user_id = $1 AND cadence = $2
         ORDER BY generated_at DESC
         LIMIT 1`,
        [userId, cadence],
      );
      return result.rows[0] ?? null;
    }
    const result = await query<TwinBriefingRow>(
      `SELECT * FROM twin_briefings
       WHERE user_id = $1
       ORDER BY generated_at DESC
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * List briefings for a user, ordered newest-first.
   */
  async listForUser(userId: string, opts: { cadence?: 'daily' | 'weekly'; limit?: number } = {}): Promise<TwinBriefingRow[]> {
    const limit = opts.limit ?? 20;
    if (opts.cadence) {
      const result = await query<TwinBriefingRow>(
        `SELECT * FROM twin_briefings
         WHERE user_id = $1 AND cadence = $2
         ORDER BY generated_at DESC
         LIMIT $3`,
        [userId, opts.cadence, limit],
      );
      return result.rows;
    }
    const result = await query<TwinBriefingRow>(
      `SELECT * FROM twin_briefings
       WHERE user_id = $1
       ORDER BY generated_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows;
  },

  /**
   * Mark a briefing as read by setting read_at to now().
   */
  async markRead(id: string): Promise<TwinBriefingRow | null> {
    const result = await query<TwinBriefingRow>(
      `UPDATE twin_briefings
       SET read_at = now()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return result.rows[0] ?? null;
  },
};
