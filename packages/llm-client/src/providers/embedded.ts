import {
  createEmbeddedTextPort,
  type EmbeddedTextPort,
  type EmbeddedTextUnavailableReason,
} from '@skytwin/embedded-llm';
import type { ChatMessage, GenerateOptions } from '../types.js';
import { toMessages } from '../messages.js';

/**
 * Cached `EmbeddedTextPort` instance keyed by model path. Subprocess-based
 * backends are stateless once constructed (each `.generate()` spawns a
 * fresh process), but the runtime detection that `createEmbeddedTextPort`
 * runs hits `existsSync` and `which` — caching avoids redoing that on
 * every request.
 */
const PORT_CACHE = new Map<string, Promise<EmbeddedTextPort>>();

export type EmbeddedProviderReadiness =
  | {
    state: 'ready';
    modelName: string | null;
    artifactSha256: string | null;
    runtimeVersion: string | null;
    workflowAuthoringQualified: boolean;
  }
  | {
    state: 'artifact_unavailable' | 'runtime_unavailable';
    reason: EmbeddedTextUnavailableReason | 'embedded_port_unavailable';
  };

function explicitModelPath(model: string | undefined): string | undefined {
  return model && model !== '' && model !== 'auto' && model !== 'default' && model !== 'managed'
    ? model
    : undefined;
}

function getPort(modelPath: string | undefined): Promise<EmbeddedTextPort> {
  const key = modelPath ?? '__auto__';
  let cached = PORT_CACHE.get(key);
  if (cached === undefined) {
    cached = createEmbeddedTextPort(modelPath !== undefined ? { modelPath } : {});
    PORT_CACHE.set(key, cached);
  }
  return cached;
}

/** Reuse the generation port cache so readiness never re-hashes a managed artifact. */
export async function probeEmbeddedProviderReadiness(
  model: string | undefined,
): Promise<EmbeddedProviderReadiness> {
  const modelPath = explicitModelPath(model);
  const port = await getPort(modelPath);
  if (port.capabilities.available) {
    return {
      state: 'ready',
      modelName: port.capabilities.modelName,
      artifactSha256: port.capabilities.artifactSha256 ?? null,
      runtimeVersion: port.capabilities.runtimeVersion ?? null,
      workflowAuthoringQualified:
        port.capabilities.workflowAuthoringQualified ?? false,
    };
  }
  // Missing prerequisites can be installed while the API stays running.
  // Do not let a cached Null port make the user-facing Retry button stale.
  PORT_CACHE.delete(modelPath ?? '__auto__');
  const reason = port.capabilities.unavailableReason ?? 'embedded_port_unavailable';
  return {
    state: reason === 'artifact_missing' || reason === 'artifact_invalid'
      ? 'artifact_unavailable'
      : 'runtime_unavailable',
    reason,
  };
}

/**
 * Render a `ChatMessage[]` to the single-string prompt format that
 * llama.cpp expects when invoked via `llama-completion -p ...`. Mirrors the
 * loose structure most chat models recognize: `system:` / `user:` /
 * `assistant:` line prefixes.
 *
 * Inline `system` messages take precedence over `options.systemPrompt`,
 * matching the OpenAI / Ollama providers in this directory.
 */
function buildPrompt(prompt: string | ChatMessage[], options: GenerateOptions): string {
  const inputMessages = toMessages(prompt);
  const hasInlineSystem = inputMessages.some((m) => m.role === 'system');
  const messages: ChatMessage[] = [];
  if (
    options.systemPrompt !== undefined &&
    options.systemPrompt !== '' &&
    !hasInlineSystem
  ) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push(...inputMessages);

  return messages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n')
    .concat(options.disableReasoning === true
      ? '\n\n/no_think\n\nassistant:'
      : '\n\nassistant:');
}

/**
 * Embedded provider — wraps `@skytwin/embedded-llm.LlamaCppTextBackend`.
 *
 * - `apiKey` is ignored (subprocess auth is "you have the binary").
 * - `model` selects a specific GGUF when set to an absolute path; the
 *   sentinel value `'auto'` falls back to env-var resolution + first
 *   matching file in the detected `modelDir`.
 * - `baseUrl` is ignored.
 *
 * If the binary is missing or no GGUF is resolvable, the underlying
 * port is `NullEmbeddedTextPort` whose `.generate()` throws
 * `NotAvailableError` — which the LlmClient chain treats like any
 * other provider failure (tries the next provider).
 */
export async function generate(
  _apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions & { baseUrl?: string } = {},
): Promise<string> {
  const modelPath = explicitModelPath(model);
  const port = await getPort(modelPath);
  const text = await port.generate(buildPrompt(prompt, options), {
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    jsonSchema: options.jsonSchema,
    disableReasoning: options.disableReasoning,
  });
  return text.trim();
}

/** Clear automatic and explicit ports after the active model changes. */
export function clearEmbeddedPortCache(): void {
  PORT_CACHE.clear();
}

/** @deprecated Test compatibility alias. */
export const _clearEmbeddedPortCache = clearEmbeddedPortCache;
