import { query } from '../connection.js';
import type { PreferenceHistoryRow } from '../types.js';

export interface CreatePreferenceHistoryInput {
  preferenceId: string;
  userId: string;
  previousValue: unknown;
  newValue: unknown;
  previousConfidence: string | null;
  newConfidence: string;
  attributionType: 'feedback' | 'evidence' | 'explicit' | 'inference';
  attributionId?: string;
}

export const preferenceHistoryRepository = {
  async create(input: CreatePreferenceHistoryInput): Promise<PreferenceHistoryRow> {
    const id = `phist_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const result = await query(
      `INSERT INTO preference_history (id, preference_id, user_id, previous_value, new_value, previous_confidence, new_confidence, attribution_type, attribution_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        input.preferenceId,
        input.userId,
        JSON.stringify(input.previousValue),
        JSON.stringify(input.newValue),
        input.previousConfidence,
        input.newConfidence,
        input.attributionType,
        input.attributionId ?? null,
      ],
    );

    return result.rows[0] as PreferenceHistoryRow;
  },

  async getForPreference(preferenceId: string, limit = 50): Promise<PreferenceHistoryRow[]> {
    const result = await query(
      `SELECT * FROM preference_history WHERE preference_id = $1 ORDER BY changed_at DESC LIMIT $2`,
      [preferenceId, limit],
    );
    return result.rows as PreferenceHistoryRow[];
  },

  async getForUser(userId: string, limit = 100): Promise<PreferenceHistoryRow[]> {
    const result = await query(
      `SELECT * FROM preference_history WHERE user_id = $1 ORDER BY changed_at DESC LIMIT $2`,
      [userId, limit],
    );
    return result.rows as PreferenceHistoryRow[];
  },

  async getByAttribution(
    attributionType: string,
    attributionId: string,
  ): Promise<PreferenceHistoryRow[]> {
    const result = await query(
      `SELECT * FROM preference_history WHERE attribution_type = $1 AND attribution_id = $2 ORDER BY changed_at DESC`,
      [attributionType, attributionId],
    );
    return result.rows as PreferenceHistoryRow[];
  },

  async getAtPointInTime(
    userId: string,
    pointInTime: Date,
  ): Promise<PreferenceHistoryRow[]> {
    const result = await query(
      `SELECT DISTINCT ON (preference_id) *
       FROM preference_history
       WHERE user_id = $1 AND changed_at <= $2
       ORDER BY preference_id, changed_at DESC`,
      [userId, pointInTime],
    );
    return result.rows as PreferenceHistoryRow[];
  },
};
