import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GenerateOptions, ProviderEntry } from '../types.js';

// Mock the provider modules. vi.mock is hoisted so these are set up before any imports.
const mockAnthropicGenerate = vi.fn();
const mockAnthropicStream = vi.fn();
const mockOpenaiGenerate = vi.fn();
const mockGoogleGenerate = vi.fn();
const mockOllamaGenerate = vi.fn();
const mockEmbeddedGenerate = vi.fn();
const mockTrustedRouterGenerate = vi.fn();

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
vi.mock('../providers/embedded.js', () => ({
  generate: (...args: unknown[]) => mockEmbeddedGenerate(...args),
}));
vi.mock('../providers/trustedrouter.js', () => ({
  generate: (...args: unknown[]) => mockTrustedRouterGenerate(...args),
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
    mockEmbeddedGenerate.mockReset();
    mockTrustedRouterGenerate.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('redacts assistant memory email addresses only at a cloud provider boundary', async () => {
    const { LlmClient } = await freshImport();
    mockAnthropicGenerate.mockResolvedValue('ok');
    const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider]);
    await client.generate('question', {
      systemPrompt: 'Memory: Contact Alice at alice@example.com about 2026-06-15. Phone 555-0100.',
      invocationKind: 'interactive',
    });
    expect(mockAnthropicGenerate).toHaveBeenCalledWith(
      anthropicProvider.apiKey,
      anthropicProvider.model,
      'question',
      expect.objectContaining({
        systemPrompt: 'Memory: Contact Alice at [redacted:email] about 2026-06-15. Phone 555-0100.',
      }),
    );
  });

  it('preserves assistant memory context for local providers', async () => {
    const { LlmClient } = await freshImport();
    const ollamaProvider: ProviderEntry = { name: 'ollama', apiKey: '', model: 'local-model' };
    mockOllamaGenerate.mockResolvedValue('ok');
    const client = LlmClient.forReasoningMode('on_device', [ollamaProvider]);
    await client.generate('question', {
      systemPrompt: 'Memory: alice@example.com and Alice 555-0100.',
      invocationKind: 'interactive',
    });
    expect(mockOllamaGenerate).toHaveBeenCalledWith(
      '',
      'local-model',
      'question',
      expect.objectContaining({ systemPrompt: 'Memory: alice@example.com and Alice 555-0100.' }),
    );
  });

  it('applies the same cloud redaction boundary to streaming assistant replies', async () => {
    const { LlmClient } = await freshImport();
    mockAnthropicStream.mockReturnValue(fromChunks(['ok']));
    const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider]);

    const events: unknown[] = [];
    for await (const event of client.generateStream('question', {
      systemPrompt: 'Memory: bob@example.com',
      invocationKind: 'interactive',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(mockAnthropicStream).toHaveBeenCalledWith(
      anthropicProvider.apiKey,
      anthropicProvider.model,
      'question',
      expect.objectContaining({ systemPrompt: 'Memory: [redacted:email]' }),
    );
  });

  it('redacts system-role assistant context in sync chat messages for cloud providers', async () => {
    const { LlmClient } = await freshImport();
    mockAnthropicGenerate.mockResolvedValue('ok');
    const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider]);
    await client.generate([
      { role: 'system', content: 'Memory: alice@example.com' },
      { role: 'user', content: 'What do you know?' },
    ], { invocationKind: 'interactive' });

    expect(mockAnthropicGenerate).toHaveBeenCalledWith(
      anthropicProvider.apiKey,
      anthropicProvider.model,
      [
        { role: 'system', content: 'Memory: [redacted:email]' },
        { role: 'user', content: 'What do you know?' },
      ],
      expect.anything(),
    );
  });

  it('redacts remote Ollama despite its zero-cost pricing', async () => {
    const { LlmClient } = await freshImport();
    mockOllamaGenerate.mockResolvedValue('ok');
    const remoteOllama: ProviderEntry = {
      name: 'ollama', apiKey: '', model: 'llama3', baseUrl: 'https://ollama.example.test',
    };
    const client = LlmClient.forReasoningMode('bring_your_own_provider', [remoteOllama]);
    await client.generate([
      { role: 'system', content: 'Memory: alice@example.com' },
    ], { invocationKind: 'interactive' });

    expect(mockOllamaGenerate).toHaveBeenCalledWith(
      '', 'llama3', [{ role: 'system', content: 'Memory: [redacted:email]' }], expect.anything(),
    );
  });

  it('keeps loopback Ollama assistant context intact in on-device mode', async () => {
    const { LlmClient } = await freshImport();
    mockOllamaGenerate.mockResolvedValue('ok');
    const localOllama: ProviderEntry = {
      name: 'ollama', apiKey: '', model: 'llama3', baseUrl: 'http://127.0.0.1:11434',
    };
    const client = LlmClient.forReasoningMode('on_device', [localOllama]);
    await client.generate([
      { role: 'system', content: 'Memory: alice@example.com' },
    ], { invocationKind: 'interactive' });

    expect(mockOllamaGenerate).toHaveBeenCalledWith(
      '', 'llama3', [{ role: 'system', content: 'Memory: alice@example.com' }], expect.anything(),
    );
  });

  it('redacts system-role assistant context in streaming cloud chat messages', async () => {
    const { LlmClient } = await freshImport();
    mockAnthropicStream.mockReturnValue(fromChunks(['ok']));
    const client = LlmClient.forReasoningMode('bring_your_own_provider', [anthropicProvider]);
    for await (const _event of client.generateStream([
      { role: 'system', content: 'Memory: bob@example.com' },
      { role: 'user', content: 'Tell me more' },
    ], { invocationKind: 'interactive' })) {
      // Drain the stream so the provider call completes.
    }

    expect(mockAnthropicStream).toHaveBeenCalledWith(
      anthropicProvider.apiKey,
      anthropicProvider.model,
      [
        { role: 'system', content: 'Memory: [redacted:email]' },
        { role: 'user', content: 'Tell me more' },
      ],
      expect.anything(),
    );
  });

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
      const client = LlmClient.forReasoningMode('bring_your_own_provider', [openaiProvider], 'receipt-user', {
        onInferenceTrace: (trace) => traces.push(trace),
        now: () => new Date('2026-09-10T00:00:00.000Z'),
      });
      await client.generate('private prompt', {
        maxTokens: 12,
        invocationKind: 'interactive',
        jsonSchema: '{"type":"object"}',
        disableReasoning: true,
      });
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        execution: {
          reasoningMode: 'bring_your_own_provider',
          provider: 'openai',
          model: 'gpt-4o',
          capabilities: { executionLocation: 'remote_service', networkScope: 'external' },
          executionPath: [{ provider: 'openai', outcome: 'succeeded' }],
        },
        status: 'conventional',
        endpointIdentity: 'https://api.openai.com', cost: { basis: 'unknown' },
      });
      expect(Buffer.from(traces[0]!.request).toString()).toBe(
        JSON.stringify({
          prompt: 'private prompt',
          maxTokens: 12,
          jsonSchema: '{"type":"object"}',
          disableReasoning: true,
        }),
      );
      expect(Buffer.from(traces[0]!.response).toString()).toBe('cloud response');
      expect(traces[0]).not.toHaveProperty('verification');
    });

    it('does not share mutable execution metadata between a response and its trace', async () => {
      const { LlmClient } = await freshImport();
      mockOpenaiGenerate.mockResolvedValue('cloud response');
      const traces: import('../types.js').InferenceTrace[] = [];
      const client = LlmClient.forReasoningMode(
        'bring_your_own_provider',
        [openaiProvider],
        'receipt-snapshot-user',
        { onInferenceTrace: (trace) => traces.push(trace) },
      );

      const response = await client.generate('private prompt', { invocationKind: 'interactive' });
      const captured = traces[0]!;

      expect(response.execution).not.toBe(captured.execution);
      expect(response.execution.request).not.toBe(captured.execution.request);
      expect(response.execution.capabilities).not.toBe(captured.execution.capabilities);
      expect(response.execution.capabilities.retention)
        .not.toBe(captured.execution.capabilities.retention);
      expect(response.execution.capabilities.modalities)
        .not.toBe(captured.execution.capabilities.modalities);
      expect(response.execution.executionPath).not.toBe(captured.execution.executionPath);
      expect(response.execution.executionPath[0]).not.toBe(captured.execution.executionPath[0]);
      expect(response.execution.costBasis).not.toBe(captured.execution.costBasis);
      expect(Object.isFrozen(response.execution)).toBe(true);
      expect(Object.isFrozen(response.execution.capabilities)).toBe(true);
      expect(Object.isFrozen(response.execution.capabilities.retention)).toBe(true);
      expect(Object.isFrozen(response.execution.capabilities.modalities)).toBe(true);
      expect(Object.isFrozen(response.execution.executionPath)).toBe(true);
      expect(Object.isFrozen(response.execution.executionPath[0])).toBe(true);
      expect(Object.isFrozen(response.execution.costBasis)).toBe(true);
      expect(Reflect.set(response.execution, 'provider', 'google')).toBe(false);
      expect(captured.execution.provider).toBe('openai');
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
      const options = {
        maxTokens: 12,
        systemPrompt: 'bound system',
        invocationKind: 'interactive' as const,
      };
      const traces: import('../types.js').InferenceTrace[] = [];
      const client = LlmClient.forReasoningMode('bring_your_own_provider', [provider], 'snapshot-user', {
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
        execution: { model: 'bound-model' },
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
      const client = LlmClient.forReasoningMode(
        'on_device',
        [{ name: 'ollama', apiKey: '', model: 'local' }],
        'local-user',
        { onInferenceTrace: (trace) => traces.push(trace) },
      );
      await client.generate('prompt');
      expect(traces[0]).toMatchObject({
        execution: {
          reasoningMode: 'on_device',
          capabilities: { executionLocation: 'on_device', networkScope: 'loopback' },
          executionPath: [{ provider: 'ollama', outcome: 'succeeded' }],
        },
        status: 'on_device',
        cost: { basis: 'exact', currency: 'USD', amountMinor: 0 },
      });
      expect(traces[0]).not.toHaveProperty('verification');
    });

    it('rejects caller-injected receipt modes before any provider call', async () => {
      const { LlmClient } = await freshImport();
      expect(() => LlmClient.forReasoningMode('bring_your_own_provider', [{
        ...openaiProvider,
        reasoningMode: 'verified_confidential',
      } as unknown as ProviderEntry], 'spoof-user')).toThrow(
        expect.objectContaining({ code: 'invalid_provider' }),
      );
      expect(mockOpenaiGenerate).not.toHaveBeenCalled();
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

    it('does not start a fallback provider after the total deadline expires', async () => {
      vi.useFakeTimers();
      const { LlmClient, AllProvidersFailedError } = await freshImport();
      mockAnthropicGenerate.mockImplementation((
        _apiKey: string,
        _model: string,
        _prompt: string,
        options: GenerateOptions,
      ) => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('provider timeout')), options.timeoutMs);
      }));
      mockOpenaiGenerate.mockResolvedValue('must not run');
      const client = LlmClient.forReasoningMode(
        'bring_your_own_provider',
        [anthropicProvider, openaiProvider],
      );

      const pending = client.generate('Help', {
        invocationKind: 'interactive',
        timeoutMs: 100,
      });
      const rejection = expect(pending).rejects.toThrow(AllProvidersFailedError);
      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(mockAnthropicGenerate).toHaveBeenCalledOnce();
      expect(mockOpenaiGenerate).not.toHaveBeenCalled();
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
    it('records only verifier-owned exact bytes for a verified private response', async () => {
      const { LlmClient } = await freshImport();
      const traces: import('../types.js').InferenceTrace[] = [];
      const requestBytes = Buffer.from('{"exact":"request"}');
      const responseBytes = Buffer.from('{"exact":"response"}');
      mockTrustedRouterGenerate.mockResolvedValue({
        content: 'verified response',
        requestBytes,
        responseBytes,
        endpointIdentity: 'https://api.trustedrouter.com/v1',
        providerRequestId: 'chat-1',
        resolvedModel: 'provider/private-model',
        verification: {
          outcome: 'verified',
          inferenceId: 'chat-1',
          attestationPolicyVersion: 'policy-1',
          verifierVersion: 'verifier-1',
          evidence: new Uint8Array([1]),
          measurementIdentity: 'measurement-1',
          responseSignature: {
            algorithm: 'Ed25519', keyId: 'key-1', publicKeyPem: 'pem', signatureBase64: 'sig',
          },
          verifiedAt: '2026-09-16T00:00:00.000Z',
          freshUntil: '2026-09-16T00:05:00.000Z',
        },
      });
      const client = LlmClient.forReasoningMode(
        'verified_private_cloud',
        [{ name: 'trustedrouter', apiKey: 'secret', model: 'trustedrouter/confidential' }],
        'private-user',
        { onInferenceTrace: (trace) => traces.push(trace) },
      );

      const response = await client.generate('hello', { invocationKind: 'interactive' });

      expect(response).toMatchObject({
        content: 'verified response',
        model: 'provider/private-model',
        execution: {
          reasoningMode: 'verified_private_cloud',
          verificationStatus: 'verified',
          request: { providerRequestId: 'chat-1' },
        },
      });
      expect(traces[0]).toMatchObject({ status: 'verified', verification: { outcome: 'verified' } });
      expect(Buffer.from(traces[0]!.request)).toEqual(requestBytes);
      expect(Buffer.from(traces[0]!.response)).toEqual(responseBytes);
    });

    it('does not stream confidential text until the complete verified output is accepted', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();
      const traces: import('../types.js').InferenceTrace[] = [];
      mockTrustedRouterGenerate.mockResolvedValue({
        content: 'must not leak',
        requestBytes: new Uint8Array(),
        responseBytes: Buffer.from('{"response":true}'),
        endpointIdentity: 'https://api.trustedrouter.com/v1',
        providerRequestId: 'chat-invalid',
        resolvedModel: 'provider/private-model',
        verification: {
          outcome: 'verified',
          attestationPolicyVersion: 'policy-1',
          verifierVersion: 'verifier-1',
          evidence: new Uint8Array([1]),
          measurementIdentity: 'measurement-1',
          responseSignature: {
            algorithm: 'Ed25519', keyId: 'key-1', publicKeyPem: 'pem', signatureBase64: 'sig',
          },
          verifiedAt: '2026-09-16T00:00:00.000Z',
          freshUntil: '2026-09-16T00:05:00.000Z',
        },
      });
      const client = LlmClient.forReasoningMode(
        'verified_private_cloud',
        [{ name: 'trustedrouter', apiKey: 'secret', model: 'trustedrouter/confidential' }],
        'private-stream-invalid',
        { onInferenceTrace: (trace) => traces.push(trace) },
      );
      const events: import('../types.js').LlmStreamEvent[] = [];

      await expect(async () => {
        for await (const event of client.generateStream('hello', { invocationKind: 'interactive' })) {
          events.push(event);
        }
      }).rejects.toThrow(AllProvidersFailedError);

      expect(events).toEqual([]);
      expect(traces).toEqual([]);
    });

    it('records verified confidential evidence before releasing its buffered stream chunk', async () => {
      const { LlmClient } = await freshImport();
      const order: string[] = [];
      mockTrustedRouterGenerate.mockResolvedValue({
        content: 'verified stream',
        requestBytes: Buffer.from('{"request":true}'),
        responseBytes: Buffer.from('{"response":true}'),
        endpointIdentity: 'https://api.trustedrouter.com/v1',
        providerRequestId: 'chat-stream',
        resolvedModel: 'provider/private-model',
        verification: {
          outcome: 'verified',
          attestationPolicyVersion: 'policy-1',
          verifierVersion: 'verifier-1',
          evidence: new Uint8Array([1]),
          measurementIdentity: 'measurement-1',
          responseSignature: {
            algorithm: 'Ed25519', keyId: 'key-1', publicKeyPem: 'pem', signatureBase64: 'sig',
          },
          verifiedAt: '2026-09-16T00:00:00.000Z',
          freshUntil: '2026-09-16T00:05:00.000Z',
        },
      });
      const client = LlmClient.forReasoningMode(
        'verified_private_cloud',
        [{ name: 'trustedrouter', apiKey: 'secret', model: 'trustedrouter/confidential' }],
        'private-stream-valid',
        { onInferenceTrace: () => order.push('trace') },
      );

      for await (const event of client.generateStream('hello', { invocationKind: 'interactive' })) {
        order.push(event.type);
      }

      expect(order).toEqual(['trace', 'chunk', 'done']);
    });

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

    it('propagates exact identity from Ollama after embedded fallback', async () => {
      const { LlmClient } = await freshImport();
      const digest = 'a'.repeat(64);
      mockEmbeddedGenerate.mockRejectedValue(new Error('embedded unavailable'));
      mockOllamaGenerate.mockResolvedValue({
        content: 'local fallback',
        resolvedModel: 'qwen3:8b',
        runtimeIdentity: {
          provider: 'ollama',
          serverVersion: '0.18.1',
          modelDigestSha256: digest,
        },
      });
      const client = LlmClient.forReasoningMode('on_device', [
        { name: 'embedded', apiKey: '', model: 'managed' },
        { name: 'ollama', apiKey: '', model: 'qwen3:8b' },
      ], 'mixed-local-exact-identity');

      await expect(client.generate('hello', {
        invocationKind: 'interactive',
        requireExactRuntimeIdentity: true,
      })).resolves.toMatchObject({
        content: 'local fallback',
        provider: 'ollama',
        model: 'qwen3:8b',
        runtimeIdentity: {
          provider: 'ollama',
          serverVersion: '0.18.1',
          modelDigestSha256: digest,
        },
        execution: {
          executionPath: [
            { provider: 'embedded', outcome: 'failed' },
            { provider: 'ollama', outcome: 'succeeded' },
          ],
        },
      });
    });

    it('classifies remote Ollama in bring-your-own mode as conventional with unknown cost', async () => {
      const { LlmClient } = await freshImport();
      const traces: import('../types.js').InferenceTrace[] = [];
      mockOllamaGenerate.mockResolvedValue('remote operator response');
      const client = LlmClient.forReasoningMode(
        'bring_your_own_provider',
        [{
          name: 'ollama', apiKey: '', model: 'hosted-model',
          baseUrl: 'https://ollama.operator.example',
        }],
        'user-remote-ollama',
        { onInferenceTrace: (trace) => traces.push(trace) },
      );

      const response = await client.generate('hello', { invocationKind: 'interactive' });

      expect(response.execution).toMatchObject({
        reasoningMode: 'bring_your_own_provider',
        capabilities: {
          executionLocation: 'remote_service',
          networkScope: 'external',
          pricing: { kind: 'unknown' },
        },
      });
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        status: 'conventional',
        execution: {
          reasoningMode: 'bring_your_own_provider',
          provider: 'ollama',
          capabilities: {
            executionLocation: 'remote_service',
            networkScope: 'external',
            pricing: { kind: 'unknown' },
          },
        },
        cost: { basis: 'unknown' },
      });
    });

    it('rejects a cloud fallback in an on-device chain before any prompt is sent', async () => {
      const { LlmClient } = await freshImport();
      expect(() => LlmClient.forReasoningMode('on_device', [anthropicProvider]))
        .toThrow(expect.objectContaining({ code: 'cross_mode_provider' }));
      expect(mockAnthropicGenerate).not.toHaveBeenCalled();
    });

    it('dispatches only the provider snapshot admitted at construction', async () => {
      const { LlmClient } = await freshImport();
      const mutable: ProviderEntry = {
        name: 'ollama', apiKey: '', model: 'qwen', baseUrl: 'http://127.0.0.1:11434',
      };
      const client = LlmClient.forReasoningMode('on_device', [mutable], 'user-snapshot');
      mutable.name = 'openai';
      mutable.apiKey = 'must-not-leak';
      mutable.model = 'remote-model';
      mutable.baseUrl = 'https://remote.example';
      mockOllamaGenerate.mockResolvedValue('local');

      await client.generate('hello');

      expect(mockOllamaGenerate).toHaveBeenCalledWith(
        '',
        'qwen',
        'hello',
        expect.objectContaining({ baseUrl: 'http://127.0.0.1:11434' }),
      );
      expect(mockOpenaiGenerate).not.toHaveBeenCalled();
    });

    it('reports pricing from the same frozen chain used for dispatch', async () => {
      const { LlmClient } = await freshImport();
      const mutable: ProviderEntry = { name: 'ollama', apiKey: '', model: 'qwen' };
      const client = LlmClient.forReasoningMode('on_device', [mutable], 'user-pricing-snapshot');
      mutable.name = 'openai';

      const pricing = client.getProviderPricingSnapshot();

      expect(pricing).toEqual([{
        provider: 'ollama',
        pricing: { kind: 'zero', unit: 'nano_usd', source: 'local_runtime' },
      }]);
      expect(Object.isFrozen(pricing)).toBe(true);
      expect(Object.isFrozen(pricing[0])).toBe(true);
    });

    it('snapshots invocation scalars once before provider fallback awaits', async () => {
      const { LlmClient } = await freshImport();
      mockAnthropicGenerate.mockRejectedValue(new Error('first unavailable'));
      mockOpenaiGenerate.mockResolvedValue('second provider');
      let invocationReads = 0;
      const options = Object.defineProperty({}, 'invocationKind', {
        get: () => (++invocationReads === 1 ? 'interactive' : 'unattended'),
      }) as GenerateOptions;
      const client = LlmClient.forReasoningMode(
        'bring_your_own_provider', [anthropicProvider, openaiProvider], 'user-options-snapshot',
      );

      await expect(client.generate('hello', options)).resolves.toMatchObject({
        provider: 'openai',
      });

      expect(invocationReads).toBe(1);
      expect(mockAnthropicGenerate).toHaveBeenCalledOnce();
      expect(mockOpenaiGenerate).toHaveBeenCalledOnce();
      expect(Object.isFrozen(mockOpenaiGenerate.mock.calls[0]![3])).toBe(true);
    });

    it('preserves structured-output controls through the provider boundary', async () => {
      const { LlmClient } = await freshImport();
      const ollamaProvider: ProviderEntry = { name: 'ollama', apiKey: '', model: 'local-model' };
      mockOllamaGenerate.mockResolvedValue('local');
      const client = LlmClient.forReasoningMode(
        'on_device', [ollamaProvider], 'user-structured-output',
      );

      await client.generate('write a workflow', {
        jsonSchema: '{"type":"object"}',
        disableReasoning: true,
      });

      expect(mockOllamaGenerate).toHaveBeenCalledWith(
        '',
        ollamaProvider.model,
        'write a workflow',
        expect.objectContaining({
          jsonSchema: '{"type":"object"}',
          disableReasoning: true,
        }),
      );
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

    it('does not assume loopback Ollama is zero-priced in bring-your-own mode', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();
      const local: ProviderEntry = { name: 'ollama', apiKey: '', model: 'qwen' };
      mockOpenaiGenerate.mockResolvedValue('must not run');
      mockOllamaGenerate.mockResolvedValue('must not run');
      const client = LlmClient.forReasoningMode(
        'bring_your_own_provider', [openaiProvider, local], 'user-priced-fallback',
      );
      await expect(client.generate('background decision')).rejects.toBeInstanceOf(
        AllProvidersFailedError,
      );
      await expect(client.generate('background decision')).rejects.toMatchObject({
        attempted: ['openai(price-unavailable)', 'ollama(price-unavailable)'],
      });
      expect(mockOpenaiGenerate).not.toHaveBeenCalled();
      expect(mockOllamaGenerate).not.toHaveBeenCalled();
    });

    it('runs source-constrained Ollama unattended in on-device mode', async () => {
      const { LlmClient } = await freshImport();
      const local: ProviderEntry = { name: 'ollama', apiKey: '', model: 'qwen' };
      mockOllamaGenerate.mockResolvedValue('local result');
      const client = LlmClient.forReasoningMode(
        'on_device', [local], 'user-local-unattended',
      );
      await expect(client.generate('background decision')).resolves.toMatchObject({
        provider: 'ollama',
        execution: { capabilities: { executionLocation: 'on_device' } },
      });
      expect(mockOllamaGenerate).toHaveBeenCalledOnce();
      expect(mockOllamaGenerate).toHaveBeenCalledWith(
        '',
        'qwen',
        'background decision',
        expect.objectContaining({ reasoningMode: 'on_device' }),
      );
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

    it('snapshots streaming invocation scalars once before fallback awaits', async () => {
      mockAnthropicStream.mockImplementationOnce(async function* () {
        throw new Error('first unavailable');
      });
      mockOpenaiGenerate.mockResolvedValueOnce('second provider');
      let invocationReads = 0;
      const options = Object.defineProperty({}, 'invocationKind', {
        get: () => (++invocationReads === 1 ? 'interactive' : 'unattended'),
      }) as GenerateOptions;
      const { LlmClient } = await freshImport();
      const client = LlmClient.forReasoningMode(
        'bring_your_own_provider', [anthropicProvider, openaiProvider], 'user-stream-options',
      );

      const events: unknown[] = [];
      for await (const event of client.generateStream('hello', options)) events.push(event);

      expect(invocationReads).toBe(1);
      expect(mockAnthropicStream).toHaveBeenCalledOnce();
      expect(mockOpenaiGenerate).toHaveBeenCalledOnce();
      expect(Object.isFrozen(mockOpenaiGenerate.mock.calls[0]![3])).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'done', provider: 'openai', content: 'second provider',
      }));
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
