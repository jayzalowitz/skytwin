import {
  aiProviderRepository,
  type AIProviderSettingsRow,
} from '@skytwin/db';
import type { AIProviderName } from '@skytwin/shared-types';
import {
  LlmClient,
  ProviderModePolicyError,
  type ProviderEntry,
} from '@skytwin/llm-client';

const PROVIDER_NAMES = new Set<AIProviderName>([
  'anthropic', 'openai', 'google', 'ollama', 'embedded',
]);

function isProviderName(value: string): value is AIProviderName {
  return PROVIDER_NAMES.has(value as AIProviderName);
}

function toProvider(row: AIProviderSettingsRow): ProviderEntry | null {
  if (!isProviderName(row.provider)) return null;
  return {
    name: row.provider,
    apiKey: row.api_key,
    model: row.model,
    baseUrl: row.base_url ?? undefined,
  };
}

export type UserLlmClientResolution =
  | { state: 'ready'; client: LlmClient }
  | {
    state: 'no_provider' | 'confirmation_required' | 'policy_blocked';
    client: null;
    reason: string;
  };

/**
 * The sole per-user LLM composition root. Every caller receives the same
 * persisted location policy and enabled-provider interpretation.
 */
export async function resolveUserLlmClient(userId: string): Promise<UserLlmClientResolution> {
  const { providers: allRows, reasoningMode: setting } =
    await aiProviderRepository.getReasoningSnapshotForUser(userId);
  const rows = allRows.filter((row) => row.enabled);
  if (setting.requires_confirmation || setting.mode === null) {
    return {
      state: 'confirmation_required',
      client: null,
      reason: 'Legacy provider configuration requires an explicit reasoning-mode choice',
    };
  }
  if (rows.length === 0) {
    return { state: 'no_provider', client: null, reason: 'No enabled provider is configured' };
  }
  const providers = rows.map(toProvider);
  if (providers.some((provider) => provider === null)) {
    return {
      state: 'policy_blocked',
      client: null,
      reason: 'An enabled provider is not recognized by this build',
    };
  }
  try {
    return {
      state: 'ready',
      client: LlmClient.forReasoningMode(setting.mode, providers as ProviderEntry[], userId),
    };
  } catch (error) {
    if (error instanceof ProviderModePolicyError) {
      return { state: 'policy_blocked', client: null, reason: error.message };
    }
    throw error;
  }
}

export async function buildUserLlmClient(userId: string): Promise<LlmClient | null> {
  return (await resolveUserLlmClient(userId)).client;
}
