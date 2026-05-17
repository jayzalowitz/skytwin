import { query, withTransaction } from '../connection.js';

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

  /**
   * Atomically check the per-day call cap and reserve a row in one
   * transaction. Mirrors `spendRepository.checkAndRecordSpend` —
   * CockroachDB serializable isolation makes the "SELECT COUNT(*)
   * then INSERT" pair race-safe when both run inside the same txn.
   *
   * Without this, two concurrent signal ingests for the same user
   * could each observe `count < cap` in their separate COUNTs and
   * both go on to call the LLM, collectively overshooting the cap by
   * up to N (where N = concurrent ingest workers). Copilot caught
   * the race on the original COUNT-then-later-INSERT shape.
   *
   * Returns `{ allowed, count, record }`:
   *   - `allowed: true`  → row inserted, `count` is the post-insert
   *     total, `record` is the inserted row
   *   - `allowed: false` → cap reached; `record` is null and no row
   *     was inserted; `count` is the pre-attempt total
   *
   * The reservation row starts with `succeeded: true` optimistically;
   * `updateOutcome()` flips it to `false` when the LLM call fails so
   * the ledger reflects reality (and a future analytics pass can
   * distinguish "LLM made it" from "LLM tried but failed").
   */
  async checkAndReserveCall(input: {
    userId: string;
    decisionId?: string | null;
    provider?: string | null;
    estimatedCostCents?: number;
    cap: number;
    windowHours?: number;
  }): Promise<{
    allowed: boolean;
    count: number;
    record: DraftEmailCallRow | null;
  }> {
    return withTransaction(async (client) => {
      const windowHours = input.windowHours ?? 24;
      const totalResult = await client.query<{ count: string | null }>(
        `SELECT COUNT(*)::TEXT AS count
         FROM draft_email_calls
         WHERE user_id = $1
           AND called_at >= now() - ($2::INT * INTERVAL '1 hour')`,
        [input.userId, windowHours],
      );
      const currentCount = parseInt(totalResult.rows[0]?.count ?? '0', 10);

      if (currentCount >= input.cap) {
        return { allowed: false, count: currentCount, record: null };
      }

      const insertResult = await client.query<DraftEmailCallRow>(
        `INSERT INTO draft_email_calls
           (user_id, decision_id, estimated_cost_cents, provider, succeeded)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          input.userId,
          input.decisionId ?? null,
          input.estimatedCostCents ?? 0,
          input.provider ?? null,
          true,
        ],
      );
      return {
        allowed: true,
        count: currentCount + 1,
        record: insertResult.rows[0]!,
      };
    });
  },

  /**
   * Update a previously-reserved row with the actual provider used
   * by the LlmClient chain (which can fall through past the gate's
   * estimate) and the success flag. Returns null when the row
   * doesn't exist (e.g. record() was called without a prior
   * reservation — should not happen on the normal path).
   */
  async updateOutcome(input: {
    id: string;
    provider: string | null;
    succeeded: boolean;
  }): Promise<DraftEmailCallRow | null> {
    const result = await query<DraftEmailCallRow>(
      `UPDATE draft_email_calls
       SET provider = $1, succeeded = $2
       WHERE id = $3
       RETURNING *`,
      [input.provider, input.succeeded, input.id],
    );
    return result.rows[0] ?? null;
  },
};
