import { query, withTransaction } from '../connection.js';
import { assertUserContext } from '../request-context.js';
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
   * #302: hot-path check for the draft-email per-user flag. A narrow
   * SELECT against a single boolean column — much cheaper than
   * `getProfile` on every signal ingest. Returns FALSE when the user
   * has no profile row yet (they haven't been touched by `getOrCreateProfile`
   * yet) — fail-closed.
   */
  async isDraftsEnabled(userId: string): Promise<boolean> {
    assertUserContext(userId);
    const result = await query<{ drafts_enabled: boolean }>(
      'SELECT drafts_enabled FROM twin_profiles WHERE user_id = $1',
      [userId],
    );
    return result.rows[0]?.drafts_enabled ?? false;
  },

  /**
   * #302: write side of the per-user draft-email flag. Used by the
   * dashboard / settings UI when the user opts in. Returns the updated
   * row, or null when the user has no twin_profile row yet (caller
   * should `getOrCreateProfile` first).
   */
  async setDraftsEnabled(
    userId: string,
    enabled: boolean,
  ): Promise<TwinProfileRow | null> {
    assertUserContext(userId);
    const result = await query<TwinProfileRow>(
      `UPDATE twin_profiles
       SET drafts_enabled = $1, updated_at = now()
       WHERE user_id = $2
       RETURNING *`,
      [enabled, userId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * #299: read-side of the per-user per-day call cap for draft-email.
   * Narrow SELECT; cost gate calls this once per opted-in signal-
   * ingest. Returns the schema default (100) when the user has no
   * twin_profile row yet — fail-safe-toward-restrictive: a missing
   * row could only mean the user has never been touched by
   * `getOrCreateProfile`, so the gate falls back to the documented
   * default rather than letting an unbounded number of calls through.
   */
  async getDraftsDailyCallCap(userId: string): Promise<number> {
    assertUserContext(userId);
    const result = await query<{ drafts_daily_call_cap: number }>(
      'SELECT drafts_daily_call_cap FROM twin_profiles WHERE user_id = $1',
      [userId],
    );
    return result.rows[0]?.drafts_daily_call_cap ?? 100;
  },

  /**
   * #299: write-side of the per-user per-day call cap. Used by the
   * settings UI for per-user tuning. Returns the updated row, or null
   * when the user has no twin_profile row yet.
   */
  async setDraftsDailyCallCap(
    userId: string,
    cap: number,
  ): Promise<TwinProfileRow | null> {
    assertUserContext(userId);
    if (!Number.isInteger(cap) || cap < 0) {
      throw new Error(
        `drafts_daily_call_cap must be a non-negative integer; got ${cap}`,
      );
    }
    const result = await query<TwinProfileRow>(
      `UPDATE twin_profiles
       SET drafts_daily_call_cap = $1, updated_at = now()
       WHERE user_id = $2
       RETURNING *`,
      [cap, userId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * #301: hot-path read of the eval-bench gate. Returns true when
   * the user has at least one passing eval recorded
   * (drafts_eval_passed_at IS NOT NULL). Symmetric with
   * `isDraftsEnabled` — single-column narrow read.
   *
   * NOTE: the eval-bench gate is NOT yet wired into
   * `buildDraftEmailGenerator` — that hookup is a follow-up
   * coordinated with the cost-gating PR. Until then this getter
   * exists for the dashboard / settings UI to display eval status
   * without joining the full `draft_email_eval_runs` history.
   */
  async isDraftsEvalPassed(userId: string): Promise<boolean> {
    assertUserContext(userId);
    const result = await query<{ drafts_eval_passed_at: Date | null }>(
      'SELECT drafts_eval_passed_at FROM twin_profiles WHERE user_id = $1',
      [userId],
    );
    return result.rows[0]?.drafts_eval_passed_at != null;
  },

  /**
   * #301: timestamp accessor — returns when the last passing eval
   * ran, or null if no passing run exists.
   */
  async getDraftsEvalPassedAt(userId: string): Promise<Date | null> {
    assertUserContext(userId);
    const result = await query<{ drafts_eval_passed_at: Date | null }>(
      'SELECT drafts_eval_passed_at FROM twin_profiles WHERE user_id = $1',
      [userId],
    );
    return result.rows[0]?.drafts_eval_passed_at ?? null;
  },

  /**
   * #301: explicit reset — clears the pass timestamp. Used when a
   * subsequent eval run fails and the operator wants to roll back
   * the user's gate. Typical flow uses `recordRun` (which sets the
   * timestamp on pass); this is the manual-override write side.
   */
  async clearDraftsEvalPass(userId: string): Promise<TwinProfileRow | null> {
    assertUserContext(userId);
    const result = await query<TwinProfileRow>(
      `UPDATE twin_profiles
       SET drafts_eval_passed_at = NULL, updated_at = now()
       WHERE user_id = $1
       RETURNING *`,
      [userId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Get the current twin profile for a user.
   */
  async getProfile(userId: string): Promise<TwinProfileRow | null> {
    assertUserContext(userId);
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
    assertUserContext(userId);
    const result = await query<TwinProfileRow>(
      `INSERT INTO twin_profiles (
        user_id, preferences, inferences, risk_tolerance,
        spend_norms, communication_style, routines, domain_heuristics
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id) DO NOTHING
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
    if (result.rows[0]) {
      return result.rows[0];
    }

    const existing = await this.getProfile(userId);
    if (!existing) {
      throw new Error(`Failed to create or load twin profile for user ${userId}`);
    }
    return existing;
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
    assertUserContext(userId);
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
    assertUserContext(userId);
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
    assertUserContext(userId);
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
