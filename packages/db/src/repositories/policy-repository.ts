import { query, withTransaction } from '../connection.js';
import type { ActionPolicyRow } from '../types.js';

function normalizePolicyRow(row: ActionPolicyRow): ActionPolicyRow {
  return {
    ...row,
    priority: Number(row.priority),
  };
}

export async function lockPolicyAuthorityWithClient(client: import('pg').PoolClient): Promise<void> {
  const locked = await client.query(
    'SELECT revision FROM execution_policy_authority WHERE singleton = true FOR UPDATE',
  );
  if (!locked.rows[0]) throw new Error('Execution policy authority is unavailable.');
}

export async function bumpPolicyAuthorityWithClient(client: import('pg').PoolClient): Promise<void> {
  await client.query(
    `UPDATE execution_policy_authority
        SET revision = gen_random_uuid(), updated_at = now()
      WHERE singleton = true`,
  );
}

export async function getPolicyAuthorityRevision(): Promise<string> {
  const result = await query<{ revision: string }>(
    'SELECT revision FROM execution_policy_authority WHERE singleton = true',
  );
  const revision = result.rows[0]?.revision;
  if (!revision) throw new Error('Execution policy authority is unavailable.');
  return revision;
}

async function lockPolicyOwner(
  client: import('pg').PoolClient,
  userId: string,
): Promise<boolean> {
  const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  return Boolean(owner.rows[0]);
}

async function findPolicyOwner(
  client: import('pg').PoolClient,
  policyId: string,
): Promise<string | null> {
  const result = await client.query<{ user_id: string }>(
    'SELECT user_id FROM action_policies WHERE id = $1', [policyId],
  );
  return result.rows[0]?.user_id ?? null;
}

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
      return result.rows.map(normalizePolicyRow);
    }

    const result = await query<ActionPolicyRow>(
      `SELECT * FROM action_policies
       WHERE user_id = $1 AND is_active = true
       ORDER BY priority DESC`,
      [userId],
    );
    return result.rows.map(normalizePolicyRow);
  },

  /**
   * Get a single policy by ID.
   */
  async findById(id: string): Promise<ActionPolicyRow | null> {
    const result = await query<ActionPolicyRow>(
      'SELECT * FROM action_policies WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row ? normalizePolicyRow(row) : null;
  },

  /**
   * Create a new policy.
   */
  async createPolicy(input: CreatePolicyInput): Promise<ActionPolicyRow> {
    return withTransaction(async (client) => {
      if (!await lockPolicyOwner(client, input.userId)) {
        throw new Error('Policy owner does not exist.');
      }
      await lockPolicyAuthorityWithClient(client);
      const result = await client.query<ActionPolicyRow>(
        `INSERT INTO action_policies (user_id, name, domain, rules, priority, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`, [
        input.userId,
        input.name,
        input.domain,
        JSON.stringify(input.rules ?? []),
        input.priority ?? 0,
        input.isActive ?? true,
        ],
      );
      await bumpPolicyAuthorityWithClient(client);
      return normalizePolicyRow(result.rows[0]!);
    });
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

    return withTransaction(async (client) => {
      const userId = await findPolicyOwner(client, id);
      if (!userId || !await lockPolicyOwner(client, userId)) return null;
      await lockPolicyAuthorityWithClient(client);
      const result = await client.query<ActionPolicyRow>(
        `UPDATE action_policies SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values,
      );
      const row = result.rows[0];
      if (row) await bumpPolicyAuthorityWithClient(client);
      return row ? normalizePolicyRow(row) : null;
    });
  },

  /**
   * Soft-delete a policy by marking it inactive.
   */
  async deletePolicy(id: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const userId = await findPolicyOwner(client, id);
      if (!userId || !await lockPolicyOwner(client, userId)) return false;
      await lockPolicyAuthorityWithClient(client);
      const result = await client.query(
        'UPDATE action_policies SET is_active = false WHERE id = $1', [id],
      );
      if ((result.rowCount ?? 0) > 0) {
        await bumpPolicyAuthorityWithClient(client);
      }
      return (result.rowCount ?? 0) > 0;
    });
  },

  /**
   * Hard-delete a policy from the database.
   */
  async hardDeletePolicy(id: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const userId = await findPolicyOwner(client, id);
      if (!userId || !await lockPolicyOwner(client, userId)) return false;
      await lockPolicyAuthorityWithClient(client);
      const result = await client.query('DELETE FROM action_policies WHERE id = $1', [id]);
      if ((result.rowCount ?? 0) > 0) {
        await bumpPolicyAuthorityWithClient(client);
      }
      return (result.rowCount ?? 0) > 0;
    });
  },
};
