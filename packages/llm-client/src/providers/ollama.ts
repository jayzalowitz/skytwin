import { canonicalizeProviderBaseUrl, type ReasoningMode } from '@skytwin/shared-types';
import type {
  ChatMessage,
  ExactOllamaProviderOutput,
  GenerateOptions,
  ProviderGenerateOutput,
} from '../types.js';
import { toMessages } from '../messages.js';
import { fetchCustomProviderUrl, type SafeProviderFetch } from '../url-validation.js';
import { ollamaLocalModelReference, ProviderModePolicyError } from '../provider-privacy.js';

// A literal loopback default cannot be redirected by a modified hosts file.
const DEFAULT_URL = 'http://127.0.0.1:11434';
const MIN_LOCAL_SOURCE_VERSION = Object.freeze([0, 18, 0] as const);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

interface OllamaModelIdentity {
  readonly aliases: readonly string[];
  readonly digest: string;
}

function structuredOutputFormat(jsonSchema: string | undefined): Record<string, unknown> | undefined {
  if (jsonSchema === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSchema) as unknown;
  } catch {
    throw new ProviderModePolicyError(
      'ollama_structured_output_invalid',
      'Ollama structured output requires a valid JSON Schema object',
      'ollama',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProviderModePolicyError(
      'ollama_structured_output_invalid',
      'Ollama structured output requires a valid JSON Schema object',
      'ollama',
    );
  }
  return parsed as Record<string, unknown>;
}

function supportsLocalSourceSelector(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < MIN_LOCAL_SOURCE_VERSION.length; index += 1) {
    if (actual[index]! > MIN_LOCAL_SOURCE_VERSION[index]!) return true;
    if (actual[index]! < MIN_LOCAL_SOURCE_VERSION[index]!) return false;
  }
  return true;
}

async function assertLocalSourceSelectorSupported(
  baseUrl: string,
  signal: AbortSignal,
): Promise<string> {
  let versionFetch: SafeProviderFetch | undefined;
  try {
    versionFetch = await fetchCustomProviderUrl(
      `${baseUrl}/api/version`,
      'ollama',
      { method: 'GET', signal },
    );
    if (!versionFetch.response.ok) {
      await versionFetch.response.body?.cancel().catch(() => undefined);
      throw new Error(`version endpoint returned ${versionFetch.response.status}`);
    }
    const body = await versionFetch.response.json() as { version?: unknown };
    if (!supportsLocalSourceSelector(body.version)) {
      throw new Error('version is older than 0.18.0 or malformed');
    }
    return (body.version as string).trim();
  } catch (error) {
    if (error instanceof ProviderModePolicyError) throw error;
    throw new ProviderModePolicyError(
      'ollama_local_source_unverified',
      `On-device Ollama requires version 0.18.0 or newer before prompts are sent (${error instanceof Error ? error.message : String(error)})`,
      'ollama',
    );
  } finally {
    await versionFetch?.close();
  }
}

function canonicalModelReference(value: string): string {
  const normalized = value.trim().toLowerCase();
  const lastSlash = normalized.lastIndexOf('/');
  const lastColon = normalized.lastIndexOf(':');
  return lastColon > lastSlash ? normalized : `${normalized}:latest`;
}

async function resolveExactLocalModel(
  baseUrl: string,
  configuredModel: string,
  signal: AbortSignal,
  endpoint: 'tags' | 'ps' = 'tags',
): Promise<OllamaModelIdentity> {
  let identityFetch: SafeProviderFetch | undefined;
  try {
    identityFetch = await fetchCustomProviderUrl(
      `${baseUrl}/api/${endpoint}`,
      'ollama',
      { method: 'GET', signal },
    );
    if (!identityFetch.response.ok) {
      await identityFetch.response.body?.cancel().catch(() => undefined);
      throw new Error(`${endpoint} endpoint returned ${identityFetch.response.status}`);
    }
    const body = await identityFetch.response.json() as { models?: unknown };
    if (!Array.isArray(body.models)) throw new Error(`${endpoint} response is malformed`);

    const requested = canonicalModelReference(configuredModel);
    const matches: OllamaModelIdentity[] = [];
    for (const candidate of body.models) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error(`${endpoint} entry is malformed`);
      }
      const record = candidate as Record<string, unknown>;
      if (typeof record['name'] !== 'string' || !record['name'].trim()
          || typeof record['model'] !== 'string' || !record['model'].trim()
          || typeof record['digest'] !== 'string' || !SHA256_PATTERN.test(record['digest'])) {
        throw new Error(`${endpoint} entry lacks an exact name, model, or SHA-256 digest`);
      }
      const aliases = [...new Set([
        canonicalModelReference(record['name']),
        canonicalModelReference(record['model']),
      ])];
      if (aliases.includes(requested)) {
        matches.push({ aliases, digest: record['digest'] });
      }
    }
    if (matches.length === 0) throw new Error(`selected model is absent from /api/${endpoint}`);
    if (matches.length !== 1) throw new Error('selected model resolves ambiguously');
    return matches[0]!;
  } catch (error) {
    if (error instanceof ProviderModePolicyError) throw error;
    throw new ProviderModePolicyError(
      'ollama_local_source_unverified',
      `On-device Ollama model identity could not be verified (${error instanceof Error ? error.message : String(error)})`,
      'ollama',
    );
  } finally {
    await identityFetch?.close();
  }
}

/**
 * Ollama provider. Issue #149: switched from `/api/generate` (which takes
 * a single concatenated prompt) to `/api/chat` (which takes a messages
 * array natively). Both endpoints exist on every modern Ollama server;
 * `/api/chat` matches what every other provider in the chain uses and
 * frees us from the `systemPrompt + "\n\n" + userPrompt` flattening that
 * lost role boundaries.
 *
 * Back-compat: a string `prompt` still works — `toMessages` wraps it as
 * a single user message before the request body is built.
 */
export async function generate(
  _apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions & {
    baseUrl?: string;
    reasoningMode?: ReasoningMode;
  } = {},
): Promise<ProviderGenerateOutput> {
  const baseUrl = canonicalizeProviderBaseUrl(options.baseUrl) ?? DEFAULT_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let customFetch: SafeProviderFetch | undefined;

  try {
    const requestModel = options.reasoningMode === 'on_device'
      ? ollamaLocalModelReference(model)
      : model;
    let serverVersionBefore: string | undefined;
    let modelIdentityBefore: OllamaModelIdentity | undefined;
    if (options.reasoningMode === 'on_device') {
      serverVersionBefore = await assertLocalSourceSelectorSupported(baseUrl, controller.signal);
      if (options.requireExactRuntimeIdentity) {
        modelIdentityBefore = await resolveExactLocalModel(baseUrl, model, controller.signal);
      }
    }
    // System prompt is supplied either via options.systemPrompt (legacy
    // path) or as a system-role message in the array (assistant package
    // injects context as a system turn). When both are present, the
    // inline ones win — matches OpenAI's behavior here.
    const inputMessages = toMessages(prompt);
    const hasInlineSystem = inputMessages.some((m) => m.role === 'system');
    const messages: ChatMessage[] = [];
    if (options.systemPrompt && !hasInlineSystem) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push(...inputMessages);

    const requestUrl = `${baseUrl}/api/chat`;
    const format = structuredOutputFormat(options.jsonSchema);
    const requestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: requestModel,
        messages,
        stream: false,
        ...(format === undefined ? {} : { format }),
        ...(options.disableReasoning === true ? { think: false } : {}),
        options: {
          temperature: options.temperature ?? 0.3,
          num_predict: options.maxTokens ?? 1024,
        },
      }),
      signal: controller.signal,
    } satisfies RequestInit;
    // The default endpoint is loopback, but a local service can still return a
    // 307/308 redirect that would carry the prompt off-device. Always use the
    // pinned, redirect-denying transport so `on_device` remains exact.
    customFetch = await fetchCustomProviderUrl(requestUrl, 'ollama', requestInit);
    const res = customFetch.response;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama error ${res.status}: ${body.slice(0, 200)}`);
    }

    // /api/chat returns `{ message: { role, content } }` (vs.
    // /api/generate's `{ response }`). Both fields can be empty for an
    // empty model output — return '' rather than undefined for symmetry
    // with the other providers.
    const data = await res.json() as {
      model?: unknown;
      message?: { content?: string };
      remote_host?: unknown;
      remote_model?: unknown;
    };
    const reportedRemoteExecution = (typeof data.remote_host === 'string'
        && data.remote_host.trim().length > 0)
      || (typeof data.remote_model === 'string' && data.remote_model.trim().length > 0);
    if (options.reasoningMode === 'on_device' && reportedRemoteExecution) {
      throw new ProviderModePolicyError(
        'ollama_cloud_model',
        'Ollama reported remote inference for an on-device request',
        'ollama',
      );
    }
    const content = data.message?.content ?? '';
    if (options.reasoningMode !== 'on_device' || !options.requireExactRuntimeIdentity) {
      return content;
    }
    if (serverVersionBefore === undefined || modelIdentityBefore === undefined
        || typeof data.model !== 'string' || !data.model.trim()) {
      throw new ProviderModePolicyError(
        'ollama_local_source_unverified',
        'On-device Ollama response omitted its exact selected model identity',
        'ollama',
      );
    }
    const responseModel = data.model.trim();
    if (!modelIdentityBefore.aliases.includes(canonicalModelReference(responseModel))) {
      throw new ProviderModePolicyError(
        'ollama_local_source_unverified',
        'On-device Ollama response model does not match the selected local model',
        'ollama',
      );
    }
    // `/api/ps` identifies the manifest actually resident after this request;
    // the surrounding `/api/tags` snapshots additionally detect alias moves.
    const runningModelIdentity = await resolveExactLocalModel(
      baseUrl,
      responseModel,
      controller.signal,
      'ps',
    );
    const serverVersionAfter = await assertLocalSourceSelectorSupported(baseUrl, controller.signal);
    const modelIdentityAfter = await resolveExactLocalModel(baseUrl, responseModel, controller.signal);
    if (serverVersionAfter !== serverVersionBefore
        || runningModelIdentity.digest !== modelIdentityBefore.digest
        || modelIdentityAfter.digest !== modelIdentityBefore.digest) {
      throw new ProviderModePolicyError(
        'ollama_local_source_unverified',
        'On-device Ollama runtime or selected model changed during inference',
        'ollama',
      );
    }
    return {
      content,
      resolvedModel: responseModel,
      runtimeIdentity: {
        provider: 'ollama',
        serverVersion: serverVersionBefore,
        modelDigestSha256: modelIdentityBefore.digest,
      },
    } satisfies ExactOllamaProviderOutput;
  } finally {
    clearTimeout(timeout);
    await customFetch?.close();
  }
}
