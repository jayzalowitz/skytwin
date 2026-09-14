import type { ReasoningMode } from '@skytwin/shared-types';
import type { ChatMessage, GenerateOptions } from '../types.js';
import { toMessages } from '../messages.js';
import { fetchCustomProviderUrl, type SafeProviderFetch } from '../url-validation.js';
import { ollamaLocalModelReference, ProviderModePolicyError } from '../provider-privacy.js';

// A literal loopback default cannot be redirected by a modified hosts file.
const DEFAULT_URL = 'http://127.0.0.1:11434';
const MIN_LOCAL_SOURCE_VERSION = Object.freeze([0, 18, 0] as const);

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
): Promise<void> {
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
): Promise<string> {
  const baseUrl = options.baseUrl || DEFAULT_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let customFetch: SafeProviderFetch | undefined;

  try {
    const requestModel = options.reasoningMode === 'on_device'
      ? ollamaLocalModelReference(model)
      : model;
    if (options.reasoningMode === 'on_device') {
      await assertLocalSourceSelectorSupported(baseUrl, controller.signal);
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
    const requestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: requestModel,
        messages,
        stream: false,
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
    return data.message?.content ?? '';
  } finally {
    clearTimeout(timeout);
    await customFetch?.close();
  }
}
