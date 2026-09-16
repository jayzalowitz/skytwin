import { CircuitBreaker } from '@skytwin/core';
import { randomUUID } from 'node:crypto';
import type {
  AIProviderName,
  ProviderExecutionAttempt,
  ProviderExecutionMetadata,
  ReasoningMode,
} from '@skytwin/shared-types';
import type {
  ProviderEntry,
  GenerateOptions,
  LlmResponse,
  ProviderGenerateFn,
  ProviderStreamFn,
  LlmStreamEvent,
  ChatMessage,
  InferenceTrace,
  LlmClientOptions,
  ProviderPricingSnapshot,
} from './types.js';
import {
  generate as anthropicGenerate,
  streamGenerate as anthropicStream,
} from './providers/anthropic.js';
import { generate as openaiGenerate } from './providers/openai.js';
import { generate as googleGenerate } from './providers/google.js';
import { generate as ollamaGenerate } from './providers/ollama.js';
import { generate as embeddedGenerate } from './providers/embedded.js';
import {
  isPricingUsableForUnattended,
  providerPrivacyCapabilities,
  providersForReasoningMode,
  ProviderModePolicyError,
} from './provider-privacy.js';
import {
  snapshotInferenceTrace,
  snapshotProviderExecutionMetadata,
} from './inference-trace.js';
import { isZeroCostProvider } from './cost.js';
import { redactPromptPii } from './redact.js';

const PROVIDER_FNS: Record<AIProviderName, ProviderGenerateFn> = {
  anthropic: anthropicGenerate,
  openai: openaiGenerate,
  google: googleGenerate,
  ollama: ollamaGenerate,
  embedded: embeddedGenerate,
};

/**
 * Native streaming functions per provider. Issue #146 (phase 2a).
 *
 * Anthropic ships native SSE streaming; the other providers fall back
 * to `makeFallbackStream` below — they `await generate()` and yield the
 * full response as one chunk. Same caller contract, only the UX differs:
 * native-streaming providers get a real typing animation, fallback
 * providers see the whole response land at once.
 *
 * Adding native streaming for OpenAI / Google / Ollama is just dropping
 * their `streamGenerate` here; no changes elsewhere needed.
 */
const PROVIDER_STREAM_FNS: Record<AIProviderName, ProviderStreamFn> = {
  anthropic: anthropicStream,
  openai: makeFallbackStream(openaiGenerate),
  google: makeFallbackStream(googleGenerate),
  ollama: makeFallbackStream(ollamaGenerate),
  embedded: makeFallbackStream(embeddedGenerate),
};

/**
 * Wrap a sync `generate` as a single-chunk async iterable. Lets the
 * provider chain expose a uniform streaming interface even for providers
 * we haven't implemented native streaming for yet.
 */
function makeFallbackStream(fn: ProviderGenerateFn): ProviderStreamFn {
  return async function* (apiKey, model, prompt, options) {
    const text = await fn(apiKey, model, prompt, options);
    if (text) yield text;
  };
}

/**
 * Module-level circuit breaker cache so state persists across requests.
 * Keyed by userId:providerName to prevent cross-tenant interference
 * (one user's bad key shouldn't trip the breaker for all users).
 */
const CIRCUIT_BREAKERS = new Map<string, CircuitBreaker>();

function getCircuitBreaker(userId: string, providerName: string): CircuitBreaker {
  const key = `${userId}:${providerName}`;
  let cb = CIRCUIT_BREAKERS.get(key);
  if (!cb) {
    cb = new CircuitBreaker(`llm:${key}`, {
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
    });
    CIRCUIT_BREAKERS.set(key, cb);
  }
  return cb;
}

interface ChainEntry {
  provider: Readonly<ProviderEntry>;
  generateFn: ProviderGenerateFn;
  streamFn: ProviderStreamFn;
  circuitBreaker: CircuitBreaker;
}

function snapshotProvider(provider: ProviderEntry): Readonly<ProviderEntry> {
  const name = provider.name;
  const apiKey = provider.apiKey;
  const model = provider.model;
  const baseUrl = provider.baseUrl;
  return Object.freeze(baseUrl === undefined
    ? { name, apiKey, model }
    : { name, apiKey, model, baseUrl });
}

function snapshotPrompt(prompt: string | ChatMessage[]): string | ChatMessage[] {
  if (typeof prompt === 'string') return prompt;
  return Object.freeze(prompt.map((message) => Object.freeze({
    role: message.role,
    content: message.content,
  }))) as unknown as ChatMessage[];
}

function snapshotGenerateOptions(options: GenerateOptions): Readonly<GenerateOptions> {
  return Object.freeze({
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    systemPrompt: options.systemPrompt,
    timeoutMs: options.timeoutMs,
    invocationKind: options.invocationKind,
  });
}

/**
 * Apply the provider trust boundary to system context immediately before a
 * provider call. Assistant memory is intentionally kept intact for local
 * providers (the user may be asking for an exact private fact), but cloud
 * providers receive the existing high-precision email redaction. Keeping this
 * here, after provider selection, avoids masking the local-first path and
 * ensures fallback calls are each evaluated against their actual provider.
 */
function providerGenerateOptions(
  provider: ProviderEntry,
  options: Readonly<GenerateOptions>,
): Readonly<GenerateOptions> {
  if (isZeroCostProvider(provider.name) || options.systemPrompt === undefined) return options;
  return Object.freeze({
    ...options,
    systemPrompt: redactPromptPii(options.systemPrompt),
  });
}

const DEFAULT_ENDPOINTS: Record<AIProviderName, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
  ollama: 'http://127.0.0.1:11434',
  embedded: 'local://embedded',
};

function endpointIdentity(provider: ProviderEntry): string {
  const raw = provider.baseUrl ?? DEFAULT_ENDPOINTS[provider.name];
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return raw;
  }
}

function canonicalLogicalInputBytes(
  prompt: string | ChatMessage[],
  options: GenerateOptions,
): Uint8Array {
  // This is a versioned, provider-neutral logical input representation. It is
  // not the exact HTTP body: adapters apply defaults and wire translations.
  return Buffer.from(JSON.stringify({
    prompt,
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  }), 'utf8');
}

/**
 * Thrown when all providers in the chain have failed or have open circuits.
 */
export class AllProvidersFailedError extends Error {
  readonly attempted: string[];

  constructor(attempted: string[]) {
    super(`All LLM providers failed: ${attempted.join(', ')}`);
    this.name = 'AllProvidersFailedError';
    this.attempted = attempted;
  }
}

/**
 * LLM client that walks a user-configured provider chain.
 * Each provider has its own circuit breaker. On failure, the client
 * automatically falls through to the next provider in priority order.
 */
export class LlmClient {
  private readonly chain: readonly ChainEntry[];
  private readonly options: LlmClientOptions;
  private readonly reasoningMode: ReasoningMode;

  private constructor(
    providers: readonly ProviderEntry[],
    userId: string | undefined,
    options: LlmClientOptions,
    reasoningMode: ReasoningMode,
  ) {
    this.options = Object.freeze({
      onInferenceTrace: options.onInferenceTrace,
      now: options.now,
    });
    this.reasoningMode = reasoningMode;
    const cbOwner = userId ?? 'shared';
    this.chain = Object.freeze(providers.map((candidate) => {
      const provider = snapshotProvider(candidate);
      return Object.freeze({
        provider,
        generateFn: PROVIDER_FNS[provider.name],
        streamFn: PROVIDER_STREAM_FNS[provider.name],
        circuitBreaker: getCircuitBreaker(cbOwner, provider.name),
      });
    }));
  }

  /** Construct a chain only after enforcing its explicit location boundary. */
  static forReasoningMode(
    mode: unknown,
    providers: readonly ProviderEntry[],
    userId?: string,
    options: LlmClientOptions = {},
  ): LlmClient {
    const scoped = providersForReasoningMode(mode, providers);
    return new LlmClient(scoped.providers, userId, options, scoped.mode);
  }

  private executionMetadata(
    provider: ProviderEntry,
    invocationId: string,
    executionPath: readonly ProviderExecutionAttempt[],
  ): ProviderExecutionMetadata {
    const capabilities = providerPrivacyCapabilities(provider, this.reasoningMode);
    return snapshotProviderExecutionMetadata({
      reasoningMode: this.reasoningMode,
      provider: provider.name,
      model: provider.model,
      request: { invocationId, providerRequestId: null },
      capabilities,
      verificationStatus: capabilities.attestationPolicy === 'required'
        ? 'required_missing'
        : 'not_applicable',
      executionPath,
      costBasis: {
        pricing: capabilities.pricing,
        inputTokens: null,
        outputTokens: null,
      },
      receiptId: null,
    });
  }

  private canRunUnattended(provider: ProviderEntry, nowMs = Date.now()): boolean {
    return isPricingUsableForUnattended(
      providerPrivacyCapabilities(provider, this.reasoningMode).pricing,
      nowMs,
    );
  }

  /**
   * Generate a response by walking the provider chain.
   * Skips providers with open circuit breakers.
   * Throws AllProvidersFailedError if none succeed.
   *
   * Issue #149: `prompt` accepts either a single string (treated as one
   * user-role message — preserves the pre-#149 caller contract) OR a
   * `ChatMessage[]` for multi-turn conversations. Each provider in the
   * chain translates the array to its native chat-completion shape.
   */
  async generate(prompt: string | ChatMessage[], options: GenerateOptions = {}): Promise<LlmResponse> {
    const invocationPrompt = snapshotPrompt(prompt);
    const invocationOptions = snapshotGenerateOptions(options);
    const logicalRequest = canonicalLogicalInputBytes(invocationPrompt, invocationOptions);
    const attempted: string[] = [];
    const executionPath: ProviderExecutionAttempt[] = [];
    const invocationId = randomUUID();

    for (const entry of this.chain) {
      const { provider, generateFn, circuitBreaker } = entry;

      if (invocationOptions.invocationKind !== 'interactive' && !this.canRunUnattended(provider)) {
        attempted.push(`${provider.name}(price-unavailable)`);
        executionPath.push({ provider: provider.name, outcome: 'price_unavailable' });
        continue;
      }

      if (!circuitBreaker.canExecute()) {
        attempted.push(`${provider.name}(circuit-open)`);
        executionPath.push({ provider: provider.name, outcome: 'circuit_open' });
        continue;
      }

      attempted.push(provider.name);
      const start = Date.now();
      try {
        const content = await generateFn(
          provider.apiKey,
          provider.model,
          invocationPrompt,
          providerGenerateOptions(provider, Object.freeze({
            ...invocationOptions,
            baseUrl: provider.baseUrl,
            reasoningMode: this.reasoningMode,
          })),
        );
        const successfulPath = [
          ...executionPath,
          { provider: provider.name, outcome: 'succeeded' as const },
        ];
        const execution = this.executionMetadata(provider, invocationId, successfulPath);
        this.recordSuccessfulInference(provider, logicalRequest, content, execution);
        circuitBreaker.recordSuccess();
        executionPath.push({ provider: provider.name, outcome: 'succeeded' });

        return {
          content,
          provider: provider.name,
          model: provider.model,
          latencyMs: Date.now() - start,
          execution,
        };
      } catch (err) {
        if (!(err instanceof ProviderModePolicyError)) {
          circuitBreaker.recordFailure();
        }
        executionPath.push({ provider: provider.name, outcome: 'failed' });
        console.warn(
          `[llm] ${provider.name} failed (${Date.now() - start}ms): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    throw new AllProvidersFailedError(attempted);
  }

  /**
   * Generate a response by walking the provider chain, yielding partial
   * text as it arrives. Issue #146 (phase 2a).
   *
   * Yields `{ type: 'chunk' }` events as the provider emits text, then
   * exactly one `{ type: 'done' }` event with the assembled full content
   * + provider/model/latency metadata.
   *
   * Provider-chain semantics differ slightly from sync `generate`:
   * - Once the FIRST chunk has been yielded successfully, the provider
   *   commits — we cannot fall through to the next provider mid-stream
   *   because the caller (and the user's eyes) have already received
   *   text. A mid-stream failure throws; the route must surface it as
   *   an error event in the SSE response so the UI can show the partial
   *   reply with an error caveat.
   * - Pre-first-chunk failures DO fall through: the next provider is
   *   tried as if `generate()` had failed.
   *
   * Throws `AllProvidersFailedError` if no provider produces any chunk.
   */
  async *generateStream(
    prompt: string | ChatMessage[],
    options: GenerateOptions = {},
  ): AsyncIterable<LlmStreamEvent> {
    const invocationPrompt = snapshotPrompt(prompt);
    const invocationOptions = snapshotGenerateOptions(options);
    const logicalRequest = canonicalLogicalInputBytes(invocationPrompt, invocationOptions);
    const attempted: string[] = [];
    const executionPath: ProviderExecutionAttempt[] = [];
    const invocationId = randomUUID();

    for (const entry of this.chain) {
      const { provider, streamFn, circuitBreaker } = entry;

      if (invocationOptions.invocationKind !== 'interactive' && !this.canRunUnattended(provider)) {
        attempted.push(`${provider.name}(price-unavailable)`);
        executionPath.push({ provider: provider.name, outcome: 'price_unavailable' });
        continue;
      }

      if (!circuitBreaker.canExecute()) {
        attempted.push(`${provider.name}(circuit-open)`);
        executionPath.push({ provider: provider.name, outcome: 'circuit_open' });
        continue;
      }

      attempted.push(provider.name);
      const start = Date.now();
      const collected: string[] = [];
      let firstChunkSeen = false;

      try {
        for await (const chunk of streamFn(
          provider.apiKey,
          provider.model,
          invocationPrompt,
          providerGenerateOptions(provider, Object.freeze({
            ...invocationOptions,
            baseUrl: provider.baseUrl,
            reasoningMode: this.reasoningMode,
          })),
        )) {
          if (chunk.length === 0) continue;
          collected.push(chunk);
          firstChunkSeen = true;
          yield { type: 'chunk', content: chunk };
        }
        const content = collected.join('');
        const successfulPath = [
          ...executionPath,
          { provider: provider.name, outcome: 'succeeded' as const },
        ];
        const execution = this.executionMetadata(provider, invocationId, successfulPath);
        this.recordSuccessfulInference(provider, logicalRequest, content, execution);
        circuitBreaker.recordSuccess();
        executionPath.push({ provider: provider.name, outcome: 'succeeded' });
        yield {
          type: 'done',
          content,
          provider: provider.name,
          model: provider.model,
          latencyMs: Date.now() - start,
          execution,
        };
        return;
      } catch (err) {
        if (!(err instanceof ProviderModePolicyError)) {
          circuitBreaker.recordFailure();
        }
        executionPath.push({ provider: provider.name, outcome: 'failed' });
        if (firstChunkSeen) {
          // Re-throw — caller already saw partial output, can't silently
          // re-try a different provider without producing duplicate text.
          throw err;
        }
        // Pre-first-chunk failure: fall through to the next provider.
        // eslint-disable-next-line no-console
        console.warn(
          `[llm.stream] ${provider.name} failed pre-first-chunk (${Date.now() - start}ms): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    throw new AllProvidersFailedError(attempted);
  }

  private recordSuccessfulInference(
    provider: Readonly<ProviderEntry>,
    logicalRequest: Uint8Array,
    content: string,
    execution: ProviderExecutionMetadata,
  ): void {
    const request = Uint8Array.from(logicalRequest);
    const response = Buffer.from(content, 'utf8');
    const endpoint = endpointIdentity(provider);
    const capabilities = execution.capabilities;
    const status: InferenceTrace['status'] = execution.reasoningMode === 'on_device'
      && capabilities.executionLocation === 'on_device'
      && (capabilities.networkScope === 'none' || capabilities.networkScope === 'loopback')
      && capabilities.confidentiality === 'device_local'
      ? 'on_device'
      : execution.reasoningMode === 'bring_your_own_provider'
        && capabilities.executionLocation === 'remote_service'
        && capabilities.networkScope === 'external'
        ? 'conventional'
        : (() => {
            throw new ProviderModePolicyError(
              'cross_mode_provider',
              'Observed provider execution facts do not match the selected reasoning mode',
              provider.name,
            );
          })();

    const trace = snapshotInferenceTrace({
      id: randomUUID(),
      status,
      execution,
      endpointIdentity: endpoint,
      request,
      response,
      cost: capabilities.pricing.kind === 'zero'
        ? { basis: 'exact', currency: 'USD', amountMinor: 0 }
        : { basis: 'unknown' },
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      verifierVersion: 'skytwin-llm-boundary-v1',
    });
    this.options.onInferenceTrace?.(trace);
  }

  /**
   * Test a single provider by generating a trivial response.
   */
  static async testProviderForReasoningMode(
    mode: unknown,
    provider: ProviderEntry,
  ): Promise<{ latencyMs: number; model: string }> {
    const scoped = providersForReasoningMode(mode, [provider]);
    const admitted = scoped.providers[0]!;
    const generateFn = PROVIDER_FNS[admitted.name];
    if (!generateFn) {
      throw new Error(`Unknown provider: ${admitted.name}`);
    }

    const start = Date.now();
    await generateFn(
      admitted.apiKey,
      admitted.model,
      'Respond with exactly: OK',
      {
        maxTokens: 10,
        temperature: 0,
        baseUrl: admitted.baseUrl,
        reasoningMode: scoped.mode,
      },
    );

    return { latencyMs: Date.now() - start, model: admitted.model };
  }

  /**
   * Whether the client has any providers configured.
   */
  get hasProviders(): boolean {
    return this.chain.length > 0;
  }

  /** Pricing for the exact admitted chain, without exposing credentials or endpoints. */
  getProviderPricingSnapshot(): readonly Readonly<ProviderPricingSnapshot>[] {
    return Object.freeze(this.chain.map(({ provider }) => Object.freeze({
      provider: provider.name,
      pricing: providerPrivacyCapabilities(provider, this.reasoningMode).pricing,
    })));
  }
}
