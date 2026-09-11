import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderEntry } from '../types.js';

// Mock the provider modules. vi.mock is hoisted so these are set up before any imports.
const mockAnthropicGenerate = vi.fn();
const mockAnthropicStream = vi.fn();
const mockOpenaiGenerate = vi.fn();
const mockGoogleGenerate = vi.fn();
const mockOllamaGenerate = vi.fn();

vi.mock('../providers/anthropic.js', () => ({
  generate: (...args: unknown[]) => mockAnthropicGenerate(...args),
  // streamGenerate returns an async iterable. Tests can either set this
  // directly to an async-iterable factory or use the helper below.
  streamGenerate: (...args: unknown[]) => mockAnthropicStream(...args),
}));
vi.mock('../providers/openai.js', () => ({
  generate: (...args: unknown[]) => mockOpenaiGenerate(...args),
}));
vi.mock('../providers/google.js', () => ({
  generate: (...args: unknown[]) => mockGoogleGenerate(...args),
}));
vi.mock('../providers/ollama.js', () => ({
  generate: (...args: unknown[]) => mockOllamaGenerate(...args),
}));

/** Build an async iterable from a list of chunks for streaming-mock use. */
async function* fromChunks(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

/** Build an async iterable that yields some chunks then throws. */
async function* fromChunksThenThrow(chunks: string[], err: Error): AsyncIterable<string> {
  for (const c of chunks) yield c;
  throw err;
}

// Helper to get a fresh LlmClient and AllProvidersFailedError class with clean
// module-level circuit breaker state. vi.resetModules() clears the module cache
// so the CIRCUIT_BREAKERS Map starts fresh.
async function freshImport() {
  vi.resetModules();
  const mod = await import('../llm-client.js');
  return { LlmClient: mod.LlmClient, AllProvidersFailedError: mod.AllProvidersFailedError };
}

describe('LlmClient', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAnthropicGenerate.mockReset();
    mockAnthropicStream.mockReset();
    mockOpenaiGenerate.mockReset();
    mockGoogleGenerate.mockReset();
    mockOllamaGenerate.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const anthropicProvider: ProviderEntry = {
    name: 'anthropic',
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-4-5-20250514',
  };

  const openaiProvider: ProviderEntry = {
    name: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o',
  };

  const googleProvider: ProviderEntry = {
    name: 'google',
    apiKey: 'goog-test',
    model: 'gemini-2.0-flash',
  };

  describe('generate - happy path', () => {
    it('returns response from the first provider on success', async () => {
      const { LlmClient } = await freshImport();
      mockAnthropicGenerate.mockResolvedValue('Hello from Claude');

      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider, openaiProvider]);
      const result = await client.generate('Say hello', { invocationKind: 'interactive' });

      expect(result.content).toBe('Hello from Claude');
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4-5-20250514');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.execution).toMatchObject({
        reasoningMode: 'bring_your_own_provider',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250514',
        request: { invocationId: expect.any(String), providerRequestId: null },
        verificationStatus: 'not_applicable',
        costBasis: { pricing: { kind: 'unknown' } },
        receiptId: null,
      });
      expect(mockAnthropicGenerate).toHaveBeenCalledOnce();
      expect(mockOpenaiGenerate).not.toHaveBeenCalled();
    });

    it('emits a conventional trace with exact logical bytes and unknown hosted cost', async () => {
      const { LlmClient } = await freshImport();
      mockOpenaiGenerate.mockResolvedValue('cloud response');
      const traces: import('../types.js').InferenceTrace[] = [];
      const client = new LlmClient([openaiProvider], 'receipt-user', {
        onInferenceTrace: (trace) => traces.push(trace),
        now: () => new Date('2026-09-10T00:00:00.000Z'),
      });
      await client.generate('private prompt', { maxTokens: 12 });
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        reasoningMode: 'conventional_cloud', status: 'conventional',
        endpointIdentity: 'https://api.openai.com', cost: { basis: 'unknown' },
      });
      expect(Buffer.from(traces[0]!.request).toString()).toBe(
        JSON.stringify({ prompt: 'private prompt', maxTokens: 12 }),
      );
      expect(Buffer.from(traces[0]!.response).toString()).toBe('cloud response');
      expect(traces[0]).not.toHaveProperty('verification');
    });

    it('binds receipt input and provider identity before the provider await', async () => {
      const { LlmClient } = await freshImport();
      let resolveProvider: ((value: string) => void) | undefined;
      mockOpenaiGenerate.mockImplementation(() => new Promise<string>((resolve) => {
        resolveProvider = resolve;
      }));
      const provider: ProviderEntry = {
        ...openaiProvider,
        model: 'bound-model',
        baseUrl: 'https://bound.example/v1',
      };
      const prompt = [{ role: 'user' as const, content: 'bound prompt' }];
      const options = { maxTokens: 12, systemPrompt: 'bound system' };
      const traces: import('../types.js').InferenceTrace[] = [];
      const client = new LlmClient([provider], 'snapshot-user', {
        onInferenceTrace: (trace) => traces.push(trace),
      });

      const pending = client.generate(prompt, options);
      provider.model = 'swapped-model';
      provider.baseUrl = 'https://swapped.example';
      prompt[0]!.content = 'swapped prompt';
      options.maxTokens = 999;
      options.systemPrompt = 'swapped system';
      resolveProvider?.('bound response');
      await pending;

      expect(mockOpenaiGenerate).toHaveBeenCalledWith(
        'sk-test',
        'bound-model',
        [{ role: 'user', content: 'bound prompt' }],
        expect.objectContaining({
          baseUrl: 'https://bound.example/v1',
          maxTokens: 12,
          systemPrompt: 'bound system',
        }),
      );
      expect(traces[0]).toMatchObject({
        model: 'bound-model',
        endpointIdentity: 'https://bound.example/v1',
      });
      expect(Buffer.from(traces[0]!.request).toString()).toBe(JSON.stringify({
        prompt: [{ role: 'user', content: 'bound prompt' }],
        systemPrompt: 'bound system',
        maxTokens: 12,
      }));
    });

    it('records zero-cost on-device inference without attestation fields', async () => {
      const { LlmClient } = await freshImport();
      mockOllamaGenerate.mockResolvedValue('local response');
      const traces: import('../types.js').InferenceTrace[] = [];
      const client = new LlmClient([{ name: 'ollama', apiKey: '', model: 'local' }], 'local-user', {
        onInferenceTrace: (trace) => traces.push(trace),
      });
      await client.generate('prompt');
      expect(traces[0]).toMatchObject({
        reasoningMode: 'on_device', status: 'on_device',
        cost: { basis: 'exact', currency: 'USD', amountMinor: 0 },
      });
      expect(traces[0]).not.toHaveProperty('verification');
    });

    it('rejects unverified confidential output and records explicit local fallback', async () => {
      const { LlmClient } = await freshImport();
      mockOpenaiGenerate.mockResolvedValue('unverified secret result');
      mockOllamaGenerate.mockResolvedValue('safe local result');
      const traces: import('../types.js').InferenceTrace[] = [];
      const verifier = {
        verify: vi.fn().mockResolvedValue({
          outcome: 'verification_failed' as const,
          verifierVersion: 'near-v1', reason: 'response binding did not match',
        }),
      };
      const client = new LlmClient([
        { ...openaiProvider, reasoningMode: 'verified_confidential', confidentialVerifier: verifier },
        { name: 'ollama', apiKey: '', model: 'local' },
      ], 'fallback-user', { onInferenceTrace: (trace) => traces.push(trace) });
      const result = await client.generate('prompt');
      expect(result.content).toBe('safe local result');
      expect(traces.map((item) => item.status)).toEqual(['verification_failed', 'local_fallback']);
      expect(traces[1]!.fallback).toEqual({
        origin: 'verified_confidential', destination: 'on_device',
        reason: 'response binding did not match',
      });
      expect(traces[0]).not.toHaveProperty('verification');
    });

    it('passes prompt and options to the provider', async () => {
      const { LlmClient } = await freshImport();
      mockAnthropicGenerate.mockResolvedValue('ok');

      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider]);
      await client.generate('Test prompt', {
        temperature: 0.5, maxTokens: 100, invocationKind: 'interactive',
      });

      expect(mockAnthropicGenerate).toHaveBeenCalledWith(
        'sk-ant-test',
        'claude-sonnet-4-5-20250514',
        'Test prompt',
        expect.objectContaining({ temperature: 0.5, maxTokens: 100 }),
      );
    });

    it('passes baseUrl from provider entry to generate options', async () => {
      const { LlmClient } = await freshImport();
      mockOllamaGenerate.mockResolvedValue('local response');

      const ollamaProvider: ProviderEntry = {
        name: 'ollama',
        apiKey: '',
        model: 'llama3',
        baseUrl: 'http://localhost:11434',
      };

      const client = LlmClient.forReasoningMode('on_device', [ollamaProvider]);
      await client.generate('Test');

      expect(mockOllamaGenerate).toHaveBeenCalledWith(
        '',
        'llama3',
        'Test',
        expect.objectContaining({ baseUrl: 'http://localhost:11434' }),
      );
    });
  });

  describe('generate - fallthrough on failure', () => {
    it('falls through to the next provider when the first fails', async () => {
      const { LlmClient } = await freshImport();
      mockAnthropicGenerate.mockRejectedValue(new Error('Rate limited'));
      mockOpenaiGenerate.mockResolvedValue('Hello from OpenAI');

      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider, openaiProvider]);
      const result = await client.generate('Say hello', { invocationKind: 'interactive' });

      expect(result.content).toBe('Hello from OpenAI');
      expect(result.provider).toBe('openai');
      expect(result.execution.executionPath).toEqual([
        { provider: 'anthropic', outcome: 'failed' },
        { provider: 'openai', outcome: 'succeeded' },
      ]);
      expect(mockAnthropicGenerate).toHaveBeenCalledOnce();
      expect(mockOpenaiGenerate).toHaveBeenCalledOnce();
    });

    it('falls through multiple providers until one succeeds', async () => {
      const { LlmClient } = await freshImport();
      mockAnthropicGenerate.mockRejectedValue(new Error('Down'));
      mockOpenaiGenerate.mockRejectedValue(new Error('Also down'));
      mockGoogleGenerate.mockResolvedValue('Google to the rescue');

      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider, openaiProvider, googleProvider]);
      const result = await client.generate('Help', { invocationKind: 'interactive' });

      expect(result.content).toBe('Google to the rescue');
      expect(result.provider).toBe('google');
    });
  });

  describe('generate - AllProvidersFailedError', () => {
    it('throws AllProvidersFailedError when all providers fail', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();
      mockAnthropicGenerate.mockRejectedValue(new Error('Fail 1'));
      mockOpenaiGenerate.mockRejectedValue(new Error('Fail 2'));

      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider, openaiProvider]);

      await expect(client.generate('Help', { invocationKind: 'interactive' }))
        .rejects.toThrow(AllProvidersFailedError);
    });

    it('includes attempted provider names in the error', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();
      mockAnthropicGenerate.mockRejectedValue(new Error('Fail'));
      mockOpenaiGenerate.mockRejectedValue(new Error('Fail'));

      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider, openaiProvider]);

      try {
        await client.generate('Help', { invocationKind: 'interactive' });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AllProvidersFailedError);
        const allFailed = err as InstanceType<typeof AllProvidersFailedError>;
        expect(allFailed.attempted).toContain('anthropic');
        expect(allFailed.attempted).toContain('openai');
      }
    });

    it('refuses to construct an empty chain', async () => {
      const { LlmClient } = await freshImport();
      expect(() => LlmClient.forReasoningMode('on_device', []))
        .toThrow(expect.objectContaining({ code: 'no_providers' }));
    });
  });

  describe('generate - circuit breaker skip', () => {
    it('skips a provider whose circuit breaker is open and marks it in attempted', async () => {
      const { LlmClient } = await freshImport();

      // Trip the circuit breaker for anthropic by failing 3 times
      mockAnthropicGenerate.mockRejectedValue(new Error('Fail'));
      mockOpenaiGenerate.mockResolvedValue('OpenAI response');

      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider, openaiProvider]);

      // Fail anthropic 3 times to trip its circuit breaker (threshold=3)
      for (let i = 0; i < 3; i++) {
        await client.generate('Trip breaker', { invocationKind: 'interactive' });
      }

      // Reset mocks to track the next call
      mockAnthropicGenerate.mockClear();
      mockOpenaiGenerate.mockClear();
      mockOpenaiGenerate.mockResolvedValue('Direct to OpenAI');

      // Now anthropic's circuit should be open; client should skip it
      const result = await client.generate('After breaker trip', { invocationKind: 'interactive' });

      expect(result.content).toBe('Direct to OpenAI');
      expect(result.provider).toBe('openai');
      // Anthropic should NOT have been called because its circuit is open
      expect(mockAnthropicGenerate).not.toHaveBeenCalled();
    });

    it('marks circuit-open providers in attempted list when all fail', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();

      mockAnthropicGenerate.mockRejectedValue(new Error('Fail'));
      mockOpenaiGenerate.mockRejectedValue(new Error('Fail'));

      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider, openaiProvider]);

      // Both fail 3 times each to trip both breakers
      for (let i = 0; i < 3; i++) {
        try {
          await client.generate('Trip both', { invocationKind: 'interactive' });
        } catch {
          // expected
        }
      }

      try {
        await client.generate('All open', { invocationKind: 'interactive' });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AllProvidersFailedError);
        const allFailed = err as InstanceType<typeof AllProvidersFailedError>;
        // Both should be marked as circuit-open
        expect(allFailed.attempted).toContain('anthropic(circuit-open)');
        expect(allFailed.attempted).toContain('openai(circuit-open)');
      }
    });
  });

  describe('hasProviders', () => {
    it('returns true when providers are configured', async () => {
      const { LlmClient } = await freshImport();
      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider]);
      expect(client.hasProviders).toBe(true);
    });

    it('does not expose an unscoped empty-client construction path', async () => {
      const { LlmClient } = await freshImport();
      expect(() => LlmClient.forReasoningMode('bring_your_own_provider', []))
        .toThrow(expect.objectContaining({ code: 'no_providers' }));
    });
  });

  describe('reasoning mode boundary', () => {
    it('constructs an on-device client only from local providers', async () => {
      const { LlmClient } = await freshImport();
      const local: ProviderEntry = { name: 'ollama', apiKey: '', model: 'qwen' };
      mockOllamaGenerate.mockResolvedValue('local');
      const client = LlmClient.forReasoningMode('on_device', [local], 'user-local');
      const response = await client.generate('hello');
      expect(response.execution).toMatchObject({
        reasoningMode: 'on_device',
        capabilities: { executionLocation: 'on_device', networkScope: 'loopback' },
      });
    });

    it('rejects a cloud fallback in an on-device chain before any prompt is sent', async () => {
      const { LlmClient } = await freshImport();
      expect(() => LlmClient.forReasoningMode('on_device', [anthropicProvider]))
        .toThrow(expect.objectContaining({ code: 'cross_mode_provider' }));
      expect(mockAnthropicGenerate).not.toHaveBeenCalled();
    });

    it('does not invoke an unknown-price provider for unattended reasoning', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();
      mockOpenaiGenerate.mockResolvedValue('must not run');
      const client = LlmClient.forReasoningMode(
        'bring_your_own_provider', [openaiProvider], 'user-unattended',
      );
      await expect(client.generate('background decision')).rejects.toBeInstanceOf(
        AllProvidersFailedError,
      );
      await expect(client.generate('background decision')).rejects.toMatchObject({
        attempted: ['openai(price-unavailable)'],
      });
      expect(mockOpenaiGenerate).not.toHaveBeenCalled();
    });

    it('may fall back to a priced local provider without invoking an unpriced remote one', async () => {
      const { LlmClient } = await freshImport();
      const local: ProviderEntry = { name: 'ollama', apiKey: '', model: 'qwen' };
      mockOpenaiGenerate.mockResolvedValue('must not run');
      mockOllamaGenerate.mockResolvedValue('local result');
      const client = LlmClient.forReasoningMode(
        'bring_your_own_provider', [openaiProvider, local], 'user-priced-fallback',
      );
      await expect(client.generate('background decision')).resolves.toMatchObject({
        provider: 'ollama',
        execution: { capabilities: { executionLocation: 'on_device' } },
      });
      expect(mockOpenaiGenerate).not.toHaveBeenCalled();
      expect(mockOllamaGenerate).toHaveBeenCalledOnce();
    });

    it('fails closed when the only on-device runtime is unavailable', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();
      const local: ProviderEntry = { name: 'ollama', apiKey: '', model: 'qwen' };
      mockOllamaGenerate.mockRejectedValue(new Error('runtime unavailable'));
      const client = LlmClient.forReasoningMode('on_device', [local], 'user-local-down');
      await expect(client.generate('background decision')).rejects.toBeInstanceOf(
        AllProvidersFailedError,
      );
      expect(mockAnthropicGenerate).not.toHaveBeenCalled();
      expect(mockOpenaiGenerate).not.toHaveBeenCalled();
    });
  });

  // ── Issue #146 (phase 2a) — generateStream ────────────────────────

  describe('generateStream', () => {
    it('yields chunks from the native streaming provider then a done event', async () => {
      mockAnthropicStream.mockReturnValueOnce(fromChunks(['Hello, ', 'world', '!']));
      const { LlmClient } = await freshImport();
      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider], 'user-1');

      const events: unknown[] = [];
      for await (const e of client.generateStream('hi', { invocationKind: 'interactive' })) {
        events.push(e);
      }

      expect(events).toEqual([
        { type: 'chunk', content: 'Hello, ' },
        { type: 'chunk', content: 'world' },
        { type: 'chunk', content: '!' },
        expect.objectContaining({
          type: 'done',
          content: 'Hello, world!',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5-20250514',
          latencyMs: expect.any(Number),
        }),
      ]);
    });

    it('falls through to next provider on pre-first-chunk failure', async () => {
      // Anthropic throws BEFORE yielding anything → fall through.
      mockAnthropicStream.mockImplementationOnce(async function* () {
        throw new Error('anthropic 503');
      });
      // Fallback provider (openai) succeeds via single-chunk fallback path.
      mockOpenaiGenerate.mockResolvedValueOnce('from openai');
      const { LlmClient } = await freshImport();
      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider, openaiProvider], 'user-2');

      const events: unknown[] = [];
      for await (const e of client.generateStream('hi', { invocationKind: 'interactive' })) {
        events.push(e);
      }

      expect(events).toEqual([
        { type: 'chunk', content: 'from openai' },
        expect.objectContaining({
          type: 'done',
          content: 'from openai',
          provider: 'openai',
        }),
      ]);
    });

    it('does NOT fall through after the first chunk has been yielded', async () => {
      // Anthropic yields one chunk then throws — caller already has text on
      // screen, so we cannot silently retry a different provider.
      mockAnthropicStream.mockReturnValueOnce(
        fromChunksThenThrow(['Partial reply'], new Error('anthropic mid-stream 502')),
      );
      mockOpenaiGenerate.mockResolvedValueOnce('would have worked');
      const { LlmClient } = await freshImport();
      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider, openaiProvider], 'user-3');

      const events: unknown[] = [];
      let thrown: unknown = null;
      try {
        for await (const e of client.generateStream('hi', { invocationKind: 'interactive' })) {
          events.push(e);
        }
      } catch (err) {
        thrown = err;
      }

      expect(events).toEqual([{ type: 'chunk', content: 'Partial reply' }]);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/mid-stream 502/);
      // openai must NOT have been called — once Anthropic committed by
      // yielding a chunk, the chain doesn't try other providers.
      expect(mockOpenaiGenerate).not.toHaveBeenCalled();
    });

    it('throws AllProvidersFailedError when no provider yields any chunk', async () => {
      mockAnthropicStream.mockImplementationOnce(async function* () {
        throw new Error('boom');
      });
      mockOpenaiGenerate.mockRejectedValueOnce(new Error('boom'));
      const { LlmClient, AllProvidersFailedError } = await freshImport();
      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider, openaiProvider], 'user-4');

      let thrown: unknown = null;
      try {
        for await (const _ of client.generateStream('hi', { invocationKind: 'interactive' })) {
          // unreachable
        }
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AllProvidersFailedError);
    });

    it('uses the universal fallback for non-streaming providers (single chunk)', async () => {
      // openai is wrapped via makeFallbackStream → single-chunk emission of
      // the full sync response.
      mockOpenaiGenerate.mockResolvedValueOnce('whole reply at once');
      const { LlmClient } = await freshImport();
      const client = LlmClient.forReasoningMode('bring_your_own_provider', [openaiProvider], 'user-5');

      const events: unknown[] = [];
      for await (const e of client.generateStream('hi', { invocationKind: 'interactive' })) {
        events.push(e);
      }

      const chunks = events.filter((e) => (e as { type: string }).type === 'chunk');
      expect(chunks).toEqual([{ type: 'chunk', content: 'whole reply at once' }]);
      const done = events.find((e) => (e as { type: string }).type === 'done');
      expect(done).toMatchObject({ provider: 'openai', content: 'whole reply at once' });
    });

    it('skips empty chunks (some providers emit zero-length keepalives)', async () => {
      mockAnthropicStream.mockReturnValueOnce(fromChunks(['', 'real', '', 'text']));
      const { LlmClient } = await freshImport();
      const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider], 'user-6');

      const chunks: string[] = [];
      for await (const e of client.generateStream('hi', { invocationKind: 'interactive' })) {
        if (e.type === 'chunk') chunks.push(e.content);
      }

      expect(chunks).toEqual(['real', 'text']);
    });
  });
});
