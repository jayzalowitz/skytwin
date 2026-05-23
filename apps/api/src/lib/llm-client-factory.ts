/**
 * LLM client factory for the API application.
 *
 * Reads provider configuration from environment variables and returns a
 * configured LlmClient, or null when no provider is usable. The null
 * return is the graceful-degradation signal: every caller that touches
 * the adaptive layer must handle null by falling back to its deterministic
 * path.
 *
 * Provider priority: ANTHROPIC → OPENAI → GOOGLE → OLLAMA → EMBEDDED.
 * Hosted providers are included when their API key is set. Ollama is
 * included when OLLAMA_BASE_URL is non-empty. The `embedded` provider
 * (llama.cpp via subprocess) is included as the last-resort fallback
 * when SKYTWIN_LLAMACPP_BIN points at a real binary OR `llama-cli` is on
 * PATH — that's the path grandma uses without ever signing up for an
 * API key.
 */

import { existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
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

  if (isEmbeddedRuntimeAvailable(env)) {
    providers.push({
      name: 'embedded',
      apiKey: '',
      // 'auto' lets `@skytwin/embedded-llm` pick the first GGUF it finds in
      // the configured model directory. Power users override via
      // SKYTWIN_LLAMA_MODEL to a specific path.
      model: env['SKYTWIN_LLAMA_MODEL'] ?? 'auto',
    });
  }

  return providers;
}

/**
 * The `embedded` provider spawns `llama-cli` per request against a local
 * GGUF model. We only add it to the chain when BOTH the binary and a
 * model are present — having only one or the other guarantees every
 * call throws (binary missing → spawn ENOENT; model missing →
 * NullEmbeddedTextPort throws NotAvailableError).
 *
 * Most developers have `llama-cli` on PATH via Homebrew or similar but
 * no SkyTwin model installed, so the old "binary present = available"
 * gate was wrong for them.
 *
 * Detection mirrors `@skytwin/embedded-llm`'s runtime-detector:
 *   Binary:
 *     - Prefer SKYTWIN_LLAMACPP_BIN if it points at an existing file.
 *     - Otherwise probe PATH for `llama-cli` (Unix) / `llama-cli.exe` (Win).
 *   Model:
 *     - Prefer SKYTWIN_LLAMA_MODEL if it points at an existing file.
 *     - Otherwise scan SKYTWIN_LLAMA_MODELS for a *.gguf file.
 *
 * Explicitly disabling: set SKYTWIN_DISABLE_EMBEDDED=1 to skip even when
 * both are present (useful when running an evaluation against only
 * hosted providers).
 */
function isEmbeddedRuntimeAvailable(env: Record<string, string | undefined>): boolean {
  if (env['SKYTWIN_DISABLE_EMBEDDED'] === '1' || env['SKYTWIN_DISABLE_EMBEDDED'] === 'true') {
    return false;
  }
  if (!hasLlamaBinary(env)) return false;
  if (!hasLlamaModel(env)) return false;
  return true;
}

function hasLlamaBinary(env: Record<string, string | undefined>): boolean {
  const explicit = env['SKYTWIN_LLAMACPP_BIN'];
  if (explicit && existsSync(explicit)) return true;

  const probeCmd = process.platform === 'win32' ? 'where llama-cli' : 'which llama-cli';
  try {
    execSync(probeCmd, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function hasLlamaModel(env: Record<string, string | undefined>): boolean {
  const explicit = env['SKYTWIN_LLAMA_MODEL'];
  if (explicit && existsSync(explicit)) return true;

  const modelDir = env['SKYTWIN_LLAMA_MODELS'];
  if (modelDir !== undefined && modelDir !== '' && existsSync(modelDir)) {
    try {
      const entries = readdirSync(modelDir);
      return entries.some((e) => e.toLowerCase().endsWith('.gguf'));
    } catch {
      return false;
    }
  }
  return false;
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
