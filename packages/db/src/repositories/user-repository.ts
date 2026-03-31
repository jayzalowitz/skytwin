import { query, withTransaction } from '../connection.js';
import type { UserRow } from '../types.js';

/**
 * Input for creating a new user.
 */
export interface CreateUserInput {
  email: string;
  name: string;
  trustTier?: string;
  autonomySettings?: Record<string, unknown>;
}

/**
 * Input for updating an existing user.
 */
export interface UpdateUserInput {
  email?: string;
  name?: string;
}

/**
 * Repository for user CRUD operations.
 */
export const userRepository = {
  /**
   * Find a user by their UUID.
   */
  async findById(id: string): Promise<UserRow | null> {
    const result = await query<UserRow>(
      'SELECT * FROM users WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Find a user by email address.
   */
  async findByEmail(email: string): Promise<UserRow | null> {
    const result = await query<UserRow>(
      'SELECT * FROM users WHERE email = $1',
      [email],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Create a new user.
   */
  async create(input: CreateUserInput): Promise<UserRow> {
    const result = await query<UserRow>(
      `INSERT INTO users (email, name, trust_tier, autonomy_settings)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        input.email,
        input.name,
        input.trustTier ?? 'observer',
        JSON.stringify(input.autonomySettings ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Update user fields (email, name).
   */
  async update(id: string, input: UpdateUserInput): Promise<UserRow | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.email !== undefined) {
      setClauses.push(`email = $${paramIndex}`);
      values.push(input.email);
      paramIndex++;
    }

    if (input.name !== undefined) {
      setClauses.push(`name = $${paramIndex}`);
      values.push(input.name);
      paramIndex++;
    }

    if (setClauses.length === 0) {
      return this.findById(id);
    }

    setClauses.push(`updated_at = now()`);
    values.push(id);

    const result = await query<UserRow>(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values,
    );
    return result.rows[0] ?? null;
  },

  /**
   * Update a user's autonomy settings.
   */
  async updateAutonomySettings(
    id: string,
    settings: Record<string, unknown>,
  ): Promise<UserRow | null> {
    const result = await query<UserRow>(
      `UPDATE users
       SET autonomy_settings = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(settings), id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Update a user's trust tier.
   */
  async updateTrustTier(
    id: string,
    trustTier: string,
  ): Promise<UserRow | null> {
    const result = await query<UserRow>(
      `UPDATE users
       SET trust_tier = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [trustTier, id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Delete a user and all related data within a transaction.
   */
  async delete(id: string): Promise<boolean> {
    return withTransaction(async (client) => {
      // Delete in dependency order
      await client.query('DELETE FROM feedback_events WHERE user_id = $1', [id]);
      await client.query('DELETE FROM approval_requests WHERE user_id = $1', [id]);
      await client.query(
        `DELETE FROM explanation_records WHERE decision_id IN
         (SELECT id FROM decisions WHERE user_id = $1)`,
        [id],
      );
      await client.query(
        `DELETE FROM execution_results WHERE plan_id IN
         (SELECT ep.id FROM execution_plans ep
          JOIN candidate_actions ca ON ep.action_id = ca.id
          JOIN decisions d ON ca.decision_id = d.id
          WHERE d.user_id = $1)`,
        [id],
      );
      await client.query(
        `DELETE FROM execution_plans WHERE action_id IN
         (SELECT ca.id FROM candidate_actions ca
          JOIN decisions d ON ca.decision_id = d.id
          WHERE d.user_id = $1)`,
        [id],
      );
      await client.query(
        `DELETE FROM decision_outcomes WHERE decision_id IN
         (SELECT id FROM decisions WHERE user_id = $1)`,
        [id],
      );
      await client.query(
        `DELETE FROM candidate_actions WHERE decision_id IN
         (SELECT id FROM decisions WHERE user_id = $1)`,
        [id],
      );
      await client.query('DELETE FROM decisions WHERE user_id = $1', [id]);
      await client.query('DELETE FROM action_policies WHERE user_id = $1', [id]);
      await client.query('DELETE FROM preferences WHERE user_id = $1', [id]);
      await client.query(
        `DELETE FROM twin_profile_versions WHERE profile_id IN
         (SELECT id FROM twin_profiles WHERE user_id = $1)`,
        [id],
      );
      await client.query('DELETE FROM twin_profiles WHERE user_id = $1', [id]);
      await client.query('DELETE FROM connected_accounts WHERE user_id = $1', [id]);

      const result = await client.query('DELETE FROM users WHERE id = $1', [id]);
      return (result.rowCount ?? 0) > 0;
    });
  },
};
