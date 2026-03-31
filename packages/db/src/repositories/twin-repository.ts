import { query, withTransaction } from '../connection.js';
import type { TwinProfileRow, TwinProfileVersionRow } from '../types.js';

/**
 * Fields that can be updated on a twin profile.
 */
export interface UpdateProfileInput {
  preferences?: unknown[];
  inferences?: unknown[];
  risk_tolerance?: Record<string, unknown>;
  spend_norms?: Record<string, unknown>;
  communication_style?: Record<string, unknown>;
  routines?: unknown[];
  domain_heuristics?: Record<string, unknown>;
}

/**
 * Repository for twin profile operations.
 * Supports versioned profile updates with snapshot history.
 */
export const twinRepository = {
  /**
   * Get the current twin profile for a user.
   */
  async getProfile(userId: string): Promise<TwinProfileRow | null> {
    const result = await query<TwinProfileRow>(
      'SELECT * FROM twin_profiles WHERE user_id = $1',
      [userId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Create a new twin profile for a user.
   * Each user can only have one profile (enforced by UNIQUE constraint).
   */
  async createProfile(
    userId: string,
    initial?: Partial<UpdateProfileInput>,
  ): Promise<TwinProfileRow> {
    const result = await query<TwinProfileRow>(
      `INSERT INTO twin_profiles (
        user_id, preferences, inferences, risk_tolerance,
        spend_norms, communication_style, routines, domain_heuristics
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        userId,
        JSON.stringify(initial?.preferences ?? []),
        JSON.stringify(initial?.inferences ?? []),
        JSON.stringify(initial?.risk_tolerance ?? {}),
        JSON.stringify(initial?.spend_norms ?? {}),
        JSON.stringify(initial?.communication_style ?? {}),
        JSON.stringify(initial?.routines ?? []),
        JSON.stringify(initial?.domain_heuristics ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Update a twin profile and create a version snapshot.
   * This is done atomically in a transaction.
   */
  async updateProfile(
    userId: string,
    updates: UpdateProfileInput,
    reason?: string,
  ): Promise<TwinProfileRow | null> {
    return withTransaction(async (client) => {
      // Get the current profile
      const currentResult = await client.query<TwinProfileRow>(
        'SELECT * FROM twin_profiles WHERE user_id = $1 FOR UPDATE',
        [userId],
      );
      const current = currentResult.rows[0];
      if (!current) return null;

      // Determine which fields changed
      const changedFields: string[] = [];
      const ALLOWED_COLUMNS = new Set([
        'preferences', 'inferences', 'risk_tolerance', 'spend_norms',
        'communication_style', 'routines', 'domain_heuristics',
      ]);
      const updateKeys = Object.keys(updates).filter(
        (k) => ALLOWED_COLUMNS.has(k),
      ) as (keyof UpdateProfileInput)[];
      for (const key of updateKeys) {
        if (updates[key] !== undefined) {
          changedFields.push(key);
        }
      }

      if (changedFields.length === 0) {
        return current;
      }

      // Create a version snapshot of the current state
      const snapshot: Record<string, unknown> = {
        preferences: current.preferences,
        inferences: current.inferences,
        risk_tolerance: current.risk_tolerance,
        spend_norms: current.spend_norms,
        communication_style: current.communication_style,
        routines: current.routines,
        domain_heuristics: current.domain_heuristics,
      };

      await client.query(
        `INSERT INTO twin_profile_versions (profile_id, version, snapshot, changed_fields, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          current.id,
          current.version,
          JSON.stringify(snapshot),
          changedFields,
          reason ?? null,
        ],
      );

      // Build the update query dynamically
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      for (const key of updateKeys) {
        if (updates[key] !== undefined) {
          setClauses.push(`${key} = $${paramIndex}`);
          values.push(JSON.stringify(updates[key]));
          paramIndex++;
        }
      }

      setClauses.push(`version = $${paramIndex}`);
      values.push(current.version + 1);
      paramIndex++;

      setClauses.push(`updated_at = now()`);

      values.push(userId);

      const updateResult = await client.query<TwinProfileRow>(
        `UPDATE twin_profiles SET ${setClauses.join(', ')} WHERE user_id = $${paramIndex} RETURNING *`,
        values,
      );

      return updateResult.rows[0] ?? null;
    });
  },

  /**
   * Get the version history of a twin profile.
   */
  async getProfileHistory(
    userId: string,
    limit = 50,
  ): Promise<TwinProfileVersionRow[]> {
    const result = await query<TwinProfileVersionRow>(
      `SELECT tpv.*
       FROM twin_profile_versions tpv
       JOIN twin_profiles tp ON tpv.profile_id = tp.id
       WHERE tp.user_id = $1
       ORDER BY tpv.version DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows;
  },

  /**
   * Get a specific version of a twin profile.
   */
  async getProfileAtVersion(
    userId: string,
    version: number,
  ): Promise<TwinProfileVersionRow | null> {
    const result = await query<TwinProfileVersionRow>(
      `SELECT tpv.*
       FROM twin_profile_versions tpv
       JOIN twin_profiles tp ON tpv.profile_id = tp.id
       WHERE tp.user_id = $1 AND tpv.version = $2`,
      [userId, version],
    );
    return result.rows[0] ?? null;
  },
};
