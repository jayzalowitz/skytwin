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

/**
 * One streaming event yielded by `LlmClient.generateStream`.
 *
 * `chunk` events carry partial text as it arrives from the provider.
 * `done` is yielded exactly once at the end with the assembled full
 * content + the same metadata the sync `generate` would have returned.
 *
 * Issue #146 — phase 2a SSE streaming for the assistant.
 */
export type LlmStreamEvent =
  | { type: 'chunk'; content: string }
  | { type: 'done'; content: string; provider: AIProviderName; model: string; latencyMs: number };

/**
 * Provider-level streaming function signature. Returns an async iterable
 * of text chunks (no metadata wrapping) — `LlmClient.generateStream`
 * adds the `done` event with provider/model/latency around the iterable.
 *
 * Providers that don't support native streaming (Google, Ollama in this
 * codebase) can be wrapped by the universal fallback in `llm-client.ts`,
 * which awaits the full sync `generate` response and yields it as a
 * single chunk. Same shape, same caller contract — only the UX differs.
 */
export type ProviderStreamFn = (
  apiKey: string,
  model: string,
  prompt: string,
  options: GenerateOptions & { baseUrl?: string },
) => AsyncIterable<string>;
