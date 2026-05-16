import { query, withTransaction } from '../connection.js';
import type { SpendRecordRow } from '../types.js';

/**
 * Input for recording a spend event.
 */
export interface CreateSpendRecordInput {
  userId: string;
  actionId: string;
  decisionId: string;
  estimatedCostCents: number;
  actualCostCents?: number;
}

/**
 * Repository for spend tracking operations.
 */
export const spendRepository = {
  /**
   * Record a new spend event (when an action is approved/executed).
   */
  async create(input: CreateSpendRecordInput): Promise<SpendRecordRow> {
    const result = await query<SpendRecordRow>(
      `INSERT INTO spend_records (user_id, action_id, decision_id, estimated_cost_cents, actual_cost_cents)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.userId,
        input.actionId,
        input.decisionId,
        input.estimatedCostCents,
        input.actualCostCents ?? null,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Get total spend in a rolling window.
   * Uses actual_cost_cents if available, falls back to estimated_cost_cents.
   */
  async getDailyTotal(userId: string, windowHours: number = 24): Promise<number> {
    const result = await query<{ total: string | null }>(
      `SELECT SUM(COALESCE(actual_cost_cents, estimated_cost_cents)) as total
       FROM spend_records
       WHERE user_id = $1
         AND recorded_at >= now() - ($2::int * INTERVAL '1 hour')`,
      [userId, windowHours],
    );
    return parseInt(result.rows[0]?.total ?? '0', 10);
  },

  /**
   * Get total spend for a user in the current calendar month (UTC).
   * When appRegistryId is provided, filters to spend records tagged with
   * that registry id in the action metadata (best-effort; requires the
   * decision pipeline to record registry_id on spend_records — tracked
   * in #306). For now, returns user-total if no appRegistryId, or 0 if
   * appRegistryId is provided (safe fallback — no false positives).
   */
  async getMonthlyTotal(userId: string, appRegistryId?: string): Promise<number> {
    // Per-app monthly totals require action-level registry_id linkage that
    // the schema doesn't yet have (deferred to #306). Return 0 for
    // per-app queries so the monthly cap check is conservative (never
    // falsely blocks). Return the calendar-month total for user-global queries.
    if (appRegistryId) {
      // TODO (#306): join through decision_outcomes → spend_records where
      // the action's registry_id = appRegistryId once that column exists.
      return 0;
    }

    const result = await query<{ total: string | null }>(
      `SELECT SUM(COALESCE(actual_cost_cents, estimated_cost_cents)) AS total
       FROM spend_records
       WHERE user_id = $1
         AND recorded_at >= date_trunc('month', now())`,
      [userId],
    );
    return parseInt(result.rows[0]?.total ?? '0', 10);
  },

  /**
   * Reconcile a spend record with the actual cost after execution.
   */
  async reconcile(actionId: string, actualCostCents: number): Promise<SpendRecordRow | null> {
    const result = await query<SpendRecordRow>(
      `UPDATE spend_records
       SET actual_cost_cents = $1, reconciled_at = now()
       WHERE action_id = $2
       RETURNING *`,
      [actualCostCents, actionId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Atomically check daily spend limit and record the spend in one transaction.
   * Prevents TOCTOU race conditions by doing the check+insert together.
   * Returns the current total (after insert) and whether it was allowed.
   */
  async checkAndRecordSpend(
    input: CreateSpendRecordInput,
    dailyLimitCents: number,
    windowHours: number = 24,
  ): Promise<{ allowed: boolean; currentTotal: number; record: SpendRecordRow | null }> {
    return withTransaction(async (client) => {
      // Read current total within the transaction (CockroachDB serializable isolation
      // ensures no concurrent transaction can insert between this read and our write)
      const totalResult = await client.query<{ total: string | null }>(
        `SELECT SUM(COALESCE(actual_cost_cents, estimated_cost_cents)) as total
         FROM spend_records
         WHERE user_id = $1
           AND recorded_at >= now() - ($2::int * INTERVAL '1 hour')`,
        [input.userId, windowHours],
      );
      const currentTotal = parseInt(totalResult.rows[0]?.total ?? '0', 10);

      if (currentTotal + input.estimatedCostCents > dailyLimitCents) {
        return { allowed: false, currentTotal, record: null };
      }

      // Within the same transaction, insert the spend record
      const insertResult = await client.query<SpendRecordRow>(
        `INSERT INTO spend_records (user_id, action_id, decision_id, estimated_cost_cents, actual_cost_cents)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          input.userId,
          input.actionId,
          input.decisionId,
          input.estimatedCostCents,
          input.actualCostCents ?? null,
        ],
      );

      return {
        allowed: true,
        currentTotal: currentTotal + input.estimatedCostCents,
        record: insertResult.rows[0]!,
      };
    });
  },

  /**
   * Get all spend records for a user in a time window.
   */
  async findByUser(
    userId: string,
    windowHours: number = 24,
  ): Promise<SpendRecordRow[]> {
    const result = await query<SpendRecordRow>(
      `SELECT * FROM spend_records
       WHERE user_id = $1
         AND recorded_at >= now() - ($2::int * INTERVAL '1 hour')
       ORDER BY recorded_at DESC`,
      [userId, windowHours],
    );
    return result.rows;
  },
};
