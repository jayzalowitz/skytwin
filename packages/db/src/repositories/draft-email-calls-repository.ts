import { query } from '../connection.js';

/**
 * Per-call ledger for the draft-email feature (#299).
 *
 * Each attempted LLM call lands here as one row regardless of outcome
 * — the gate decision is based on row count in the last 24h, not on
 * succeeded-only count. A user whose LLM keeps failing should still
 * be rate-limited (otherwise an infinite-retry loop could spike costs
 * the next time the provider comes back).
 *
 * Hot path is `countInLast24h(userId)` — a single COUNT(*) against
 * the `(user_id, called_at DESC)` index. The cost gate runs this
 * once per signal-ingest for opted-in users, so it's worth keeping
 * the read narrow.
 */

export interface DraftEmailCallRow {
  id: string;
  user_id: string;
  decision_id: string | null;
  estimated_cost_cents: number;
  provider: string | null;
  succeeded: boolean;
  called_at: Date;
}

export interface RecordDraftEmailCallInput {
  userId: string;
  decisionId?: string | null;
  estimatedCostCents: number;
  provider?: string | null;
  succeeded?: boolean;
}

export const draftEmailCallsRepository = {
  /**
   * Count draft-email LLM call attempts in the trailing window. Default
   * 24h matches the per-day cap semantics. Used by the cost gate
   * BEFORE the LLM call to decide whether to proceed.
   */
  async countInWindow(userId: string, windowHours: number = 24): Promise<number> {
    const result = await query<{ count: string | null }>(
      `SELECT COUNT(*)::TEXT AS count
       FROM draft_email_calls
       WHERE user_id = $1
         AND called_at >= now() - ($2::INT * INTERVAL '1 hour')`,
      [userId, windowHours],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  },

  /**
   * Record one draft-email call attempt. Inserts a single row; the
   * cost gate's count() will pick it up on the next signal-ingest.
   * Returns the inserted row for observability.
   */
  async record(input: RecordDraftEmailCallInput): Promise<DraftEmailCallRow> {
    const result = await query<DraftEmailCallRow>(
      `INSERT INTO draft_email_calls
         (user_id, decision_id, estimated_cost_cents, provider, succeeded)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.userId,
        input.decisionId ?? null,
        input.estimatedCostCents,
        input.provider ?? null,
        input.succeeded ?? true,
      ],
    );
    return result.rows[0]!;
  },
};
