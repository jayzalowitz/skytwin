import { query, withTransaction } from '../connection.js';
import type { AIProviderSettingsRow, ReasoningModeSettingsRow } from '../types.js';
import {
  canonicalizeProviderBaseUrl,
  hasSameProviderCredentialEndpoint,
  type AIProviderName,
  type ReasoningMode,
} from '@skytwin/shared-types';

class ProviderCredentialEndpointChangedError extends Error {
  readonly code = 'provider_credential_endpoint_changed';

  constructor(provider: string) {
    super(`A fresh credential is required when changing the ${provider} endpoint authority`);
    this.name = 'ProviderCredentialEndpointChangedError';
  }
}

function canonicalProviderInput(
  provider: Omit<UpsertAIProviderInput, 'userId'>,
): Omit<UpsertAIProviderInput, 'userId'> {
  return { ...provider, baseUrl: canonicalizeProviderBaseUrl(provider.baseUrl) };
}

function credentialForReplacement(
  provider: Omit<UpsertAIProviderInput, 'userId'>,
  existing: AIProviderSettingsRow | undefined,
): string {
  if (provider.apiKey && provider.apiKey.length > 0) return provider.apiKey;
  if (!existing || existing.api_key.length === 0) return '';
  if (!hasSameProviderCredentialEndpoint(
    provider.provider as AIProviderName,
    existing.base_url,
    provider.baseUrl,
  )) {
    throw new ProviderCredentialEndpointChangedError(provider.provider);
  }
  return existing.api_key;
}

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
  /** Read the routing policy and enabled chain from one serializable snapshot. */
  async getReasoningSnapshotForUser(userId: string): Promise<{
    providers: AIProviderSettingsRow[];
    reasoningMode: ReasoningModeSettingsRow;
  }> {
    return withTransaction(async (client) => {
      await client.query(
        `INSERT INTO reasoning_mode_settings (user_id, mode, requires_confirmation)
         VALUES ($1, 'on_device', false)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      const modeResult = await client.query<ReasoningModeSettingsRow>(
        'SELECT * FROM reasoning_mode_settings WHERE user_id = $1 LIMIT 1',
        [userId],
      );
      const providerResult = await client.query<AIProviderSettingsRow>(
        `SELECT * FROM ai_provider_settings
         WHERE user_id = $1
         ORDER BY priority ASC`,
        [userId],
      );
      const reasoningMode = modeResult.rows[0];
      if (!reasoningMode) throw new Error('reasoning mode snapshot returned no row');
      return { providers: providerResult.rows, reasoningMode };
    });
  },
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
    const baseUrl = canonicalizeProviderBaseUrl(input.baseUrl);
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
        baseUrl ?? null,
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
        'SELECT provider, api_key, base_url FROM ai_provider_settings WHERE user_id = $1',
        [userId],
      );
      const existingProviders = new Map(existing.rows.map((row) => [row.provider, row]));
      const replacements = providers.map((input) => {
        const provider = canonicalProviderInput(input);
        return {
          provider,
          apiKey: credentialForReplacement(provider, existingProviders.get(provider.provider)),
        };
      });

      await client.query('DELETE FROM ai_provider_settings WHERE user_id = $1', [userId]);

      const rows: AIProviderSettingsRow[] = [];
      for (const replacement of replacements) {
        const { provider: p, apiKey } = replacement;
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

  /** Atomically replace the provider chain and its independent location policy. */
  async replaceAllWithReasoningMode(
    userId: string,
    mode: ReasoningMode,
    providers: Omit<UpsertAIProviderInput, 'userId'>[],
  ): Promise<AIProviderSettingsRow[]> {
    return withTransaction(async (client) => {
      await client.query(
        `INSERT INTO reasoning_mode_settings (user_id, mode, requires_confirmation)
         VALUES ($1, $2, false)
         ON CONFLICT (user_id) DO UPDATE SET
           mode = EXCLUDED.mode,
           requires_confirmation = false,
           updated_at = now()`,
        [userId, mode],
      );
      const existing = await client.query<AIProviderSettingsRow>(
        'SELECT provider, api_key, base_url FROM ai_provider_settings WHERE user_id = $1',
        [userId],
      );
      const existingProviders = new Map(existing.rows.map((row) => [row.provider, row]));
      const replacements = providers.map((input) => {
        const provider = canonicalProviderInput(input);
        return {
          provider,
          apiKey: credentialForReplacement(provider, existingProviders.get(provider.provider)),
        };
      });
      await client.query('DELETE FROM ai_provider_settings WHERE user_id = $1', [userId]);

      const rows: AIProviderSettingsRow[] = [];
      for (const replacement of replacements) {
        const { provider, apiKey } = replacement;
        const inserted = await client.query<AIProviderSettingsRow>(
          `INSERT INTO ai_provider_settings
             (user_id, provider, api_key, model, base_url, priority, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            userId,
            provider.provider,
            apiKey,
            provider.model,
            provider.baseUrl ?? null,
            provider.priority,
            provider.enabled ?? true,
          ],
        );
        rows.push(inserted.rows[0]!);
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
