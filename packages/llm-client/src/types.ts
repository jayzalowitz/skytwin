import type { AIProviderName } from '@skytwin/shared-types';

/**
 * Configuration for a single provider in the chain.
 */
export interface ProviderEntry {
  name: AIProviderName;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

/**
 * Options for a generate call.
 */
export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  timeoutMs?: number;
}

/**
 * Normalized response from any LLM provider.
 */
export interface LlmResponse {
  content: string;
  provider: AIProviderName;
  model: string;
  latencyMs: number;
}

/**
 * Provider-level generate function signature.
 */
export type ProviderGenerateFn = (
  apiKey: string,
  model: string,
  prompt: string,
  options: GenerateOptions & { baseUrl?: string },
) => Promise<string>;
