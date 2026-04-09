import { query, withTransaction } from '../connection.js';
import type { AIProviderSettingsRow } from '../types.js';

/**
 * Input for creating or updating an AI provider setting.
 */
export interface UpsertAIProviderInput {
  userId: string;
  provider: string;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  priority: number;
  enabled?: boolean;
}

/**
 * Repository for AI provider settings operations.
 */
export const aiProviderRepository = {
  /**
   * Get all AI providers for a user, sorted by priority (lowest first).
   */
  async getForUser(userId: string): Promise<AIProviderSettingsRow[]> {
    const result = await query<AIProviderSettingsRow>(
      `SELECT * FROM ai_provider_settings
       WHERE user_id = $1
       ORDER BY priority ASC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Get only enabled providers for a user, sorted by priority.
   */
  async getEnabledForUser(userId: string): Promise<AIProviderSettingsRow[]> {
    const result = await query<AIProviderSettingsRow>(
      `SELECT * FROM ai_provider_settings
       WHERE user_id = $1 AND enabled = true
       ORDER BY priority ASC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Upsert a provider setting.
   * Uses ON CONFLICT to update if (user_id, provider) already exists.
   */
  async upsert(input: UpsertAIProviderInput): Promise<AIProviderSettingsRow> {
    const result = await query<AIProviderSettingsRow>(
      `INSERT INTO ai_provider_settings (user_id, provider, api_key, model, base_url, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         api_key = EXCLUDED.api_key,
         model = EXCLUDED.model,
         base_url = EXCLUDED.base_url,
         priority = EXCLUDED.priority,
         enabled = EXCLUDED.enabled,
         updated_at = now()
       RETURNING *`,
      [
        input.userId,
        input.provider,
        input.apiKey ?? '',
        input.model,
        input.baseUrl ?? null,
        input.priority,
        input.enabled ?? true,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Replace all providers for a user atomically.
   * Deletes existing rows and inserts the new set.
   */
  async replaceAll(userId: string, providers: Omit<UpsertAIProviderInput, 'userId'>[]): Promise<AIProviderSettingsRow[]> {
    return withTransaction(async (client) => {
      // Read existing keys before deleting so we can preserve them
      // when the client sends an empty apiKey (it only has the masked preview).
      const existing = await client.query<AIProviderSettingsRow>(
        'SELECT provider, api_key FROM ai_provider_settings WHERE user_id = $1',
        [userId],
      );
      const existingKeys = new Map(existing.rows.map((r) => [r.provider, r.api_key]));

      await client.query('DELETE FROM ai_provider_settings WHERE user_id = $1', [userId]);

      const rows: AIProviderSettingsRow[] = [];
      for (const p of providers) {
        // Preserve existing API key when client sends empty string
        const apiKey = (p.apiKey && p.apiKey.length > 0)
          ? p.apiKey
          : (existingKeys.get(p.provider) ?? '');

        const row = await client.query<AIProviderSettingsRow>(
          `INSERT INTO ai_provider_settings (user_id, provider, api_key, model, base_url, priority, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [userId, p.provider, apiKey, p.model, p.baseUrl ?? null, p.priority, p.enabled ?? true],
        );
        rows.push(row.rows[0]!);
      }
      return rows;
    });
  },

  /**
   * Delete a specific provider for a user.
   */
  async delete(userId: string, provider: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM ai_provider_settings
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Delete all providers for a user.
   */
  async deleteAll(userId: string): Promise<number> {
    const result = await query(
      'DELETE FROM ai_provider_settings WHERE user_id = $1',
      [userId],
    );
    return result.rowCount ?? 0;
  },
};
