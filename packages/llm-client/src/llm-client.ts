import { CircuitBreaker } from '@skytwin/core';
import type { AIProviderName } from '@skytwin/shared-types';
import type {
  ProviderEntry,
  GenerateOptions,
  LlmResponse,
  ProviderGenerateFn,
  ProviderStreamFn,
  LlmStreamEvent,
} from './types.js';
import {
  generate as anthropicGenerate,
  streamGenerate as anthropicStream,
} from './providers/anthropic.js';
import { generate as openaiGenerate } from './providers/openai.js';
import { generate as googleGenerate } from './providers/google.js';
import { generate as ollamaGenerate } from './providers/ollama.js';

const PROVIDER_FNS: Record<AIProviderName, ProviderGenerateFn> = {
  anthropic: anthropicGenerate,
  openai: openaiGenerate,
  google: googleGenerate,
  ollama: ollamaGenerate,
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
  provider: ProviderEntry;
  generateFn: ProviderGenerateFn;
  streamFn: ProviderStreamFn;
  circuitBreaker: CircuitBreaker;
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
  private readonly chain: ChainEntry[];

  constructor(providers: ProviderEntry[], userId?: string) {
    const cbOwner = userId ?? 'shared';
    this.chain = providers.map((p) => ({
      provider: p,
      generateFn: PROVIDER_FNS[p.name],
      streamFn: PROVIDER_STREAM_FNS[p.name],
      circuitBreaker: getCircuitBreaker(cbOwner, p.name),
    }));
  }

  /**
   * Generate a response by walking the provider chain.
   * Skips providers with open circuit breakers.
   * Throws AllProvidersFailedError if none succeed.
   */
  async generate(prompt: string, options: GenerateOptions = {}): Promise<LlmResponse> {
    const attempted: string[] = [];

    for (const entry of this.chain) {
      const { provider, generateFn, circuitBreaker } = entry;

      if (!circuitBreaker.canExecute()) {
        attempted.push(`${provider.name}(circuit-open)`);
        continue;
      }

      attempted.push(provider.name);
      const start = Date.now();

      try {
        const content = await generateFn(
          provider.apiKey,
          provider.model,
          prompt,
          { ...options, baseUrl: provider.baseUrl },
        );
        circuitBreaker.recordSuccess();

        return {
          content,
          provider: provider.name,
          model: provider.model,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        circuitBreaker.recordFailure();
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
    prompt: string,
    options: GenerateOptions = {},
  ): AsyncIterable<LlmStreamEvent> {
    const attempted: string[] = [];

    for (const entry of this.chain) {
      const { provider, streamFn, circuitBreaker } = entry;

      if (!circuitBreaker.canExecute()) {
        attempted.push(`${provider.name}(circuit-open)`);
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
          prompt,
          { ...options, baseUrl: provider.baseUrl },
        )) {
          if (chunk.length === 0) continue;
          firstChunkSeen = true;
          collected.push(chunk);
          yield { type: 'chunk', content: chunk };
        }
        circuitBreaker.recordSuccess();
        yield {
          type: 'done',
          content: collected.join(''),
          provider: provider.name,
          model: provider.model,
          latencyMs: Date.now() - start,
        };
        return;
      } catch (err) {
        circuitBreaker.recordFailure();
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

  /**
   * Test a single provider by generating a trivial response.
   */
  static async testProvider(provider: ProviderEntry): Promise<{ latencyMs: number; model: string }> {
    const generateFn = PROVIDER_FNS[provider.name];
    if (!generateFn) {
      throw new Error(`Unknown provider: ${provider.name}`);
    }

    const start = Date.now();
    await generateFn(
      provider.apiKey,
      provider.model,
      'Respond with exactly: OK',
      { maxTokens: 10, temperature: 0, baseUrl: provider.baseUrl },
    );

    return { latencyMs: Date.now() - start, model: provider.model };
  }

  /**
   * Whether the client has any providers configured.
   */
  get hasProviders(): boolean {
    return this.chain.length > 0;
  }
}
