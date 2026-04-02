import { query } from '../connection.js';
import type { TrustTierAuditRow } from '../types.js';

/**
 * Input for creating a trust tier audit record.
 */
export interface CreateTierAuditInput {
  userId: string;
  oldTier: string;
  newTier: string;
  direction: 'promotion' | 'regression';
  triggerReason: string;
  evidence: Record<string, unknown>;
}

/**
 * Repository for trust tier audit trail.
 */
export const trustTierAuditRepository = {
  /**
   * Record a trust tier change.
   */
  async create(input: CreateTierAuditInput): Promise<TrustTierAuditRow> {
    const result = await query<TrustTierAuditRow>(
      `INSERT INTO trust_tier_audit (user_id, old_tier, new_tier, direction, trigger_reason, evidence)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.userId,
        input.oldTier,
        input.newTier,
        input.direction,
        input.triggerReason,
        JSON.stringify(input.evidence),
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Get the audit trail for a user, most recent first.
   */
  async findByUser(userId: string, limit: number = 50): Promise<TrustTierAuditRow[]> {
    const result = await query<TrustTierAuditRow>(
      `SELECT * FROM trust_tier_audit
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows;
  },

  /**
   * Get the most recent tier change for a user.
   */
  async findLatest(userId: string): Promise<TrustTierAuditRow | null> {
    const result = await query<TrustTierAuditRow>(
      `SELECT * FROM trust_tier_audit
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Count tier changes in a time window (useful for rate limiting promotions).
   */
  async countInWindow(
    userId: string,
    direction: 'promotion' | 'regression',
    windowDays: number,
  ): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM trust_tier_audit
       WHERE user_id = $1
         AND direction = $2
         AND created_at >= now() - ($3::int * INTERVAL '1 day')`,
      [userId, direction, windowDays],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  },
};
