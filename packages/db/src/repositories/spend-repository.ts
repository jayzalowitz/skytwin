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
  /**
   * Optional registry source attribution (#323). When provided, the
   * spend is tagged with the registry ID so per-app monthly totals
   * (`getMonthlyTotal(userId, appRegistryId)`) can attribute it. Pass
   * `undefined` when the spend doesn't have a registry source — the
   * column stays NULL and the row only contributes to user-global
   * totals.
   */
  registryId?: string;
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
      `INSERT INTO spend_records (user_id, action_id, decision_id, estimated_cost_cents, actual_cost_cents, registry_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.userId,
        input.actionId,
        input.decisionId,
        input.estimatedCostCents,
        input.actualCostCents ?? null,
        input.registryId ?? null,
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
   *
   * When `appRegistryId` is provided (#323), filters to rows tagged
   * with that registry id via the `registry_id` column added in
   * migration 054. Rows recorded before that migration have
   * `registry_id IS NULL` and are excluded from per-app totals — they
   * only contribute when `appRegistryId` is omitted (user-global).
   * Index `idx_spend_user_registry_time` covers this query path.
   */
  async getMonthlyTotal(userId: string, appRegistryId?: string): Promise<number> {
    if (appRegistryId !== undefined) {
      const result = await query<{ total: string | null }>(
        `SELECT SUM(COALESCE(actual_cost_cents, estimated_cost_cents)) AS total
         FROM spend_records
         WHERE user_id = $1
           AND registry_id = $2
           AND recorded_at >= date_trunc('month', now())`,
        [userId, appRegistryId],
      );
      return parseInt(result.rows[0]?.total ?? '0', 10);
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
        `INSERT INTO spend_records (user_id, action_id, decision_id, estimated_cost_cents, actual_cost_cents, registry_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          input.userId,
          input.actionId,
          input.decisionId,
          input.estimatedCostCents,
          input.actualCostCents ?? null,
          input.registryId ?? null,
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
