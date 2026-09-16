import type {
  ChatMessage,
  GenerateOptions,
  ProviderGenerateOutput,
} from '../types.js';

/**
 * NEAR AI is intentionally represented in the provider registry so Settings
 * can explain why it is unavailable. Runtime admission rejects it before this
 * function is reached; this final transport boundary also fails before any
 * prompt can leave the process.
 */
export async function generate(
  _apiKey: string,
  _model: string,
  _prompt: string | ChatMessage[],
  _options: GenerateOptions = {},
): Promise<ProviderGenerateOutput> {
  throw new Error(
    'NEAR AI confidential inference is unavailable because SkyTwin cannot yet pin the dynamically selected inference workload',
  );
}
