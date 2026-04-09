import { CircuitBreaker } from '@skytwin/core';
import type { AIProviderName } from '@skytwin/shared-types';
import type { ProviderEntry, GenerateOptions, LlmResponse, ProviderGenerateFn } from './types.js';
import { generate as anthropicGenerate } from './providers/anthropic.js';
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
