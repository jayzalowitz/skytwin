import { query } from '../connection.js';
import type { ActionPolicyRow } from '../types.js';

/**
 * Input for creating a policy.
 */
export interface CreatePolicyInput {
  userId: string;
  name: string;
  domain: string;
  rules?: unknown[];
  priority?: number;
  isActive?: boolean;
}

/**
 * Input for updating a policy.
 */
export interface UpdatePolicyInput {
  name?: string;
  domain?: string;
  rules?: unknown[];
  priority?: number;
  isActive?: boolean;
}

/**
 * Repository for action policy operations.
 */
export const policyRepository = {
  /**
   * Get all policies for a user, optionally filtered by domain.
   * Results are ordered by priority descending (highest priority first).
   */
  async getPoliciesForUser(
    userId: string,
    domain?: string,
  ): Promise<ActionPolicyRow[]> {
    if (domain) {
      const result = await query<ActionPolicyRow>(
        `SELECT * FROM action_policies
         WHERE user_id = $1 AND domain = $2 AND is_active = true
         ORDER BY priority DESC`,
        [userId, domain],
      );
      return result.rows;
    }

    const result = await query<ActionPolicyRow>(
      `SELECT * FROM action_policies
       WHERE user_id = $1 AND is_active = true
       ORDER BY priority DESC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Get a single policy by ID.
   */
  async findById(id: string): Promise<ActionPolicyRow | null> {
    const result = await query<ActionPolicyRow>(
      'SELECT * FROM action_policies WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Create a new policy.
   */
  async createPolicy(input: CreatePolicyInput): Promise<ActionPolicyRow> {
    const result = await query<ActionPolicyRow>(
      `INSERT INTO action_policies (user_id, name, domain, rules, priority, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.userId,
        input.name,
        input.domain,
        JSON.stringify(input.rules ?? []),
        input.priority ?? 0,
        input.isActive ?? true,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Update an existing policy.
   */
  async updatePolicy(
    id: string,
    input: UpdatePolicyInput,
  ): Promise<ActionPolicyRow | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      setClauses.push(`name = $${paramIndex}`);
      values.push(input.name);
      paramIndex++;
    }

    if (input.domain !== undefined) {
      setClauses.push(`domain = $${paramIndex}`);
      values.push(input.domain);
      paramIndex++;
    }

    if (input.rules !== undefined) {
      setClauses.push(`rules = $${paramIndex}`);
      values.push(JSON.stringify(input.rules));
      paramIndex++;
    }

    if (input.priority !== undefined) {
      setClauses.push(`priority = $${paramIndex}`);
      values.push(input.priority);
      paramIndex++;
    }

    if (input.isActive !== undefined) {
      setClauses.push(`is_active = $${paramIndex}`);
      values.push(input.isActive);
      paramIndex++;
    }

    if (setClauses.length === 0) {
      return this.findById(id);
    }

    values.push(id);

    const result = await query<ActionPolicyRow>(
      `UPDATE action_policies SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values,
    );
    return result.rows[0] ?? null;
  },

  /**
   * Soft-delete a policy by marking it inactive.
   */
  async deletePolicy(id: string): Promise<boolean> {
    const result = await query(
      'UPDATE action_policies SET is_active = false WHERE id = $1',
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Hard-delete a policy from the database.
   */
  async hardDeletePolicy(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM action_policies WHERE id = $1',
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
