import type { ReasoningMode } from '@skytwin/shared-types';
import { query } from '../connection.js';
import type { ReasoningModeSettingsRow } from '../types.js';

export const reasoningModeRepository = {
  async getForUser(userId: string): Promise<ReasoningModeSettingsRow | null> {
    const result = await query<ReasoningModeSettingsRow>(
      'SELECT * FROM reasoning_mode_settings WHERE user_id = $1 LIMIT 1',
      [userId],
    );
    return result.rows[0] ?? null;
  },

  async getOrCreateForUser(userId: string): Promise<ReasoningModeSettingsRow> {
    const inserted = await query<ReasoningModeSettingsRow>(
      `INSERT INTO reasoning_mode_settings (user_id, mode, requires_confirmation)
       VALUES ($1, 'on_device', false)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING *`,
      [userId],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.getForUser(userId);
    if (!existing) throw new Error('reasoning mode read-after-upsert returned no row');
    return existing;
  },

  async setForUser(userId: string, mode: ReasoningMode): Promise<ReasoningModeSettingsRow> {
    const result = await query<ReasoningModeSettingsRow>(
      `INSERT INTO reasoning_mode_settings (user_id, mode, requires_confirmation)
       VALUES ($1, $2, false)
       ON CONFLICT (user_id) DO UPDATE SET
         mode = EXCLUDED.mode,
         requires_confirmation = false,
         updated_at = now()
       RETURNING *`,
      [userId, mode],
    );
    const row = result.rows[0];
    if (!row) throw new Error('reasoning mode update returned no row');
    return row;
  },

  /** Change the location policy only when the provider snapshot is compatible. */
  async setForUserIfCompatible(
    userId: string,
    mode: ReasoningMode,
  ): Promise<ReasoningModeSettingsRow | null> {
    const result = await query<ReasoningModeSettingsRow>(
      `INSERT INTO reasoning_mode_settings (user_id, mode, requires_confirmation)
       SELECT $1, $2, false
       WHERE $2 <> 'verified_private_cloud'
         AND NOT EXISTS (
           SELECT 1 FROM ai_provider_settings
           WHERE user_id = $1 AND enabled = true
             AND (
               provider NOT IN ('anthropic', 'openai', 'google', 'ollama', 'embedded')
               OR (
                 $2 = 'on_device'
                 AND (
                   provider NOT IN ('ollama', 'embedded')
                   OR (
                     provider = 'ollama'
                     AND base_url IS NOT NULL
                     AND base_url !~* '^https?://(localhost\\.?|127\\.0\\.0\\.1\\.?|\\[::1\\])(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?([/?#].*)?$'
                   )
                 )
               )
             )
         )
       ON CONFLICT (user_id) DO UPDATE SET
         mode = EXCLUDED.mode,
         requires_confirmation = false,
         updated_at = now()
       RETURNING *`,
      [userId, mode],
    );
    return result.rows[0] ?? null;
  },
};
