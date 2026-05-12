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
  /**
   * #193 follow-up: when set, this is a per-Lifebook briefing scoped to
   * that domain (matching `lifebooks.domain_name`). NULL means the
   * historical global-briefing semantic, untouched.
   */
  domain_name: string | null;
}

export interface CreateTwinBriefingInput {
  userId: string;
  cadence: 'daily' | 'weekly';
  proseMarkdown: string;
  sourceEventCount: number;
  llmProvider?: string;
  llmCostCents?: number;
  /** #193 follow-up: omit for global briefings; set for per-Lifebook ones. */
  domainName?: string;
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
         (user_id, cadence, prose_markdown, source_event_count, llm_provider, llm_cost_cents, domain_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.userId,
        input.cadence,
        input.proseMarkdown,
        input.sourceEventCount,
        input.llmProvider ?? null,
        input.llmCostCents ?? null,
        input.domainName ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('briefing insert returned no row');
    return row;
  },

  /**
   * Return the most recently generated briefing for a user, optionally
   * filtered by cadence. Only returns *global* briefings (domain_name
   * IS NULL) — the per-Lifebook query lives in
   * `getLatestForUserDomain()` so the existing surface stays bounded
   * to the historical semantic.
   */
  async getLatestForUser(userId: string, cadence?: 'daily' | 'weekly'): Promise<TwinBriefingRow | null> {
    if (cadence) {
      const result = await query<TwinBriefingRow>(
        `SELECT * FROM twin_briefings
         WHERE user_id = $1 AND cadence = $2 AND domain_name IS NULL
         ORDER BY generated_at DESC
         LIMIT 1`,
        [userId, cadence],
      );
      return result.rows[0] ?? null;
    }
    const result = await query<TwinBriefingRow>(
      `SELECT * FROM twin_briefings
       WHERE user_id = $1 AND domain_name IS NULL
       ORDER BY generated_at DESC
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * #193 follow-up: return the most recently generated briefing scoped
   * to a Lifebook domain. Returns null when no domain-scoped briefing
   * exists for that user + domain (e.g. the worker hasn't emitted one
   * yet, or the domain is too new). Per-domain briefings of either
   * cadence are valid; pass `cadence` to scope further.
   */
  async getLatestForUserDomain(
    userId: string,
    domainName: string,
    cadence?: 'daily' | 'weekly',
  ): Promise<TwinBriefingRow | null> {
    if (cadence) {
      const result = await query<TwinBriefingRow>(
        `SELECT * FROM twin_briefings
         WHERE user_id = $1 AND domain_name = $2 AND cadence = $3
         ORDER BY generated_at DESC
         LIMIT 1`,
        [userId, domainName, cadence],
      );
      return result.rows[0] ?? null;
    }
    const result = await query<TwinBriefingRow>(
      `SELECT * FROM twin_briefings
       WHERE user_id = $1 AND domain_name = $2
       ORDER BY generated_at DESC
       LIMIT 1`,
      [userId, domainName],
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
