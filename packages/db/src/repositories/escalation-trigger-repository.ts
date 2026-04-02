import { query } from '../connection.js';
import type { EscalationTriggerRow } from '../types.js';

/**
 * Input for creating an escalation trigger.
 */
export interface CreateEscalationTriggerInput {
  userId: string;
  triggerType: string;
  conditions: Record<string, unknown>;
  enabled?: boolean;
}

/**
 * Repository for escalation trigger operations.
 */
export const escalationTriggerRepository = {
  /**
   * Create a new escalation trigger.
   */
  async create(input: CreateEscalationTriggerInput): Promise<EscalationTriggerRow> {
    const result = await query<EscalationTriggerRow>(
      `INSERT INTO escalation_triggers (user_id, trigger_type, conditions, enabled)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        input.userId,
        input.triggerType,
        JSON.stringify(input.conditions),
        input.enabled ?? true,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Find a single trigger by ID.
   */
  async findById(id: string): Promise<EscalationTriggerRow | null> {
    const result = await query<EscalationTriggerRow>(
      `SELECT * FROM escalation_triggers WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Get all escalation triggers for a user.
   */
  async getForUser(userId: string): Promise<EscalationTriggerRow[]> {
    const result = await query<EscalationTriggerRow>(
      `SELECT * FROM escalation_triggers
       WHERE user_id = $1
       ORDER BY trigger_type`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Get only enabled triggers for a user.
   */
  async getEnabledForUser(userId: string): Promise<EscalationTriggerRow[]> {
    const result = await query<EscalationTriggerRow>(
      `SELECT * FROM escalation_triggers
       WHERE user_id = $1 AND enabled = true
       ORDER BY trigger_type`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Update a trigger's enabled state or conditions.
   */
  async update(
    id: string,
    updates: { enabled?: boolean; conditions?: Record<string, unknown> },
  ): Promise<EscalationTriggerRow | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.enabled !== undefined) {
      setClauses.push(`enabled = $${paramIndex++}`);
      values.push(updates.enabled);
    }
    if (updates.conditions !== undefined) {
      setClauses.push(`conditions = $${paramIndex++}`);
      values.push(JSON.stringify(updates.conditions));
    }

    if (setClauses.length === 0) return null;

    values.push(id);
    const result = await query<EscalationTriggerRow>(
      `UPDATE escalation_triggers
       SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values,
    );
    return result.rows[0] ?? null;
  },

  /**
   * Delete an escalation trigger.
   */
  async delete(id: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM escalation_triggers WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
