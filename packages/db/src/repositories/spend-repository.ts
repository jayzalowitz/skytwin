import { query } from '../connection.js';
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
         AND recorded_at >= now() - ($2 || ' hours')::INTERVAL`,
      [userId, windowHours],
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
   * Get all spend records for a user in a time window.
   */
  async findByUser(
    userId: string,
    windowHours: number = 24,
  ): Promise<SpendRecordRow[]> {
    const result = await query<SpendRecordRow>(
      `SELECT * FROM spend_records
       WHERE user_id = $1
         AND recorded_at >= now() - ($2 || ' hours')::INTERVAL
       ORDER BY recorded_at DESC`,
      [userId, windowHours],
    );
    return result.rows;
  },
};
