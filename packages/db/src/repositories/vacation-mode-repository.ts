import { query } from '../connection.js';

/**
 * Vacation mode lives on the `users` table as a single
 * `vacation_mode_until` timestamp (#194 Child 3 partial).
 *
 * Active when the column is non-null AND in the future. Setting to NULL
 * deactivates immediately. The decision-engine reads this on every
 * decision context build and shifts risk-profile thresholds when active.
 */
export const vacationModeRepository = {
  async get(userId: string): Promise<{ until: Date | null; active: boolean }> {
    const result = await query<{ vacation_mode_until: Date | null }>(
      `SELECT vacation_mode_until FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row || row.vacation_mode_until === null) return { until: null, active: false };
    return {
      until: row.vacation_mode_until,
      active: row.vacation_mode_until.getTime() > Date.now(),
    };
  },

  /**
   * Set the vacation deadline. Pass `null` to deactivate. We do NOT
   * accept past timestamps — the API layer rejects those at the
   * boundary so a malformed client can't silently re-deactivate by
   * setting `until` to yesterday.
   */
  async set(userId: string, until: Date | null): Promise<void> {
    await query(
      `UPDATE users SET vacation_mode_until = $2 WHERE id = $1`,
      [userId, until],
    );
  },
};
