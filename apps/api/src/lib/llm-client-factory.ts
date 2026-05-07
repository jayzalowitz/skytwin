/**
 * LLM client factory for the API application.
 *
 * Reads provider configuration from environment variables and returns a
 * configured LlmClient, or null when no provider API key is set. The null
 * return is the graceful-degradation signal: every caller that touches
 * the adaptive layer must handle null by falling back to its deterministic
 * path.
 *
 * Provider priority: ANTHROPIC → OPENAI → GOOGLE → OLLAMA (local, no key needed).
 * Any provider with a non-empty API key (or, for Ollama, a non-empty base URL)
 * is included in the chain; the LlmClient walks the chain on each call.
 */

import { LlmClient } from '@skytwin/llm-client';
import type { ProviderEntry } from '@skytwin/llm-client';

/** Module-level singleton so we construct the client once per process */
let _cached: LlmClient | null | undefined;

function buildProviderChain(env: Record<string, string | undefined>): ProviderEntry[] {
  const providers: ProviderEntry[] = [];

  const anthropicKey = env['ANTHROPIC_API_KEY'] ?? '';
  if (anthropicKey) {
    providers.push({
      name: 'anthropic',
      apiKey: anthropicKey,
      model: env['ANTHROPIC_MODEL'] ?? 'claude-3-5-haiku-20241022',
    });
  }

  const openaiKey = env['OPENAI_API_KEY'] ?? '';
  if (openaiKey) {
    providers.push({
      name: 'openai',
      apiKey: openaiKey,
      model: env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
    });
  }

  const googleKey = env['GOOGLE_API_KEY'] ?? '';
  if (googleKey) {
    providers.push({
      name: 'google',
      apiKey: googleKey,
      model: env['GOOGLE_MODEL'] ?? 'gemini-1.5-flash',
    });
  }

  const ollamaUrl = env['OLLAMA_BASE_URL'] ?? '';
  if (ollamaUrl) {
    providers.push({
      name: 'ollama',
      apiKey: '',
      model: env['OLLAMA_MODEL'] ?? 'llama3.2',
      baseUrl: ollamaUrl,
    });
  }

  return providers;
}

/**
 * Returns a configured LlmClient when at least one provider is available,
 * or null when no provider is configured. Callers must fall back to
 * deterministic logic when null is returned.
 *
 * The client is cached as a module-level singleton — constructing it is cheap
 * but we avoid re-reading env on every request.
 */
export function getLlmClientFromConfig(
  env: Record<string, string | undefined> = process.env,
): LlmClient | null {
  if (_cached !== undefined) return _cached;

  const providers = buildProviderChain(env);
  if (providers.length === 0) {
    _cached = null;
    return null;
  }

  _cached = new LlmClient(providers, 'system');
  return _cached;
}

/**
 * Bypass the singleton cache. Used in tests to inject a fresh client
 * without cross-test contamination.
 */
export function getLlmClientFromConfigFresh(
  env: Record<string, string | undefined> = process.env,
): LlmClient | null {
  const providers = buildProviderChain(env);
  if (providers.length === 0) return null;
  return new LlmClient(providers, 'system');
}

/**
 * Reset the singleton. Only for tests.
 */
export function _resetLlmClientCache(): void {
  _cached = undefined;
}
