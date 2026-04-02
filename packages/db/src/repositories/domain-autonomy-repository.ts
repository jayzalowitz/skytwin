import { query } from '../connection.js';
import type { DomainAutonomyPolicyRow } from '../types.js';

/**
 * Input for creating or updating a domain autonomy policy.
 */
export interface UpsertDomainAutonomyInput {
  userId: string;
  domain: string;
  trustTier: string;
  maxSpendPerActionCents?: number;
}

/**
 * Repository for domain autonomy policy operations.
 */
export const domainAutonomyRepository = {
  /**
   * Upsert a domain autonomy policy.
   * Uses ON CONFLICT to update if (user_id, domain) already exists.
   */
  async upsert(input: UpsertDomainAutonomyInput): Promise<DomainAutonomyPolicyRow> {
    const result = await query<DomainAutonomyPolicyRow>(
      `INSERT INTO domain_autonomy_policies (user_id, domain, trust_tier, max_spend_per_action_cents)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, domain) DO UPDATE SET
         trust_tier = EXCLUDED.trust_tier,
         max_spend_per_action_cents = EXCLUDED.max_spend_per_action_cents,
         updated_at = now()
       RETURNING *`,
      [
        input.userId,
        input.domain,
        input.trustTier,
        input.maxSpendPerActionCents ?? null,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Get all domain autonomy policies for a user.
   */
  async getForUser(userId: string): Promise<DomainAutonomyPolicyRow[]> {
    const result = await query<DomainAutonomyPolicyRow>(
      `SELECT * FROM domain_autonomy_policies
       WHERE user_id = $1
       ORDER BY domain`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Get the domain autonomy policy for a specific user+domain.
   */
  async getForDomain(userId: string, domain: string): Promise<DomainAutonomyPolicyRow | null> {
    const result = await query<DomainAutonomyPolicyRow>(
      `SELECT * FROM domain_autonomy_policies
       WHERE user_id = $1 AND domain = $2`,
      [userId, domain],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Delete a domain autonomy policy.
   */
  async delete(userId: string, domain: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM domain_autonomy_policies
       WHERE user_id = $1 AND domain = $2`,
      [userId, domain],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
