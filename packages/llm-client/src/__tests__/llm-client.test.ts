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

      const client = new LlmClient([anthropicProvider, openaiProvider]);
      const result = await client.generate('Say hello');

      expect(result.content).toBe('Hello from Claude');
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4-5-20250514');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(mockAnthropicGenerate).toHaveBeenCalledOnce();
      expect(mockOpenaiGenerate).not.toHaveBeenCalled();
    });

    it('passes prompt and options to the provider', async () => {
      const { LlmClient } = await freshImport();
      mockAnthropicGenerate.mockResolvedValue('ok');

      const client = new LlmClient([anthropicProvider]);
      await client.generate('Test prompt', { temperature: 0.5, maxTokens: 100 });

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

      const client = new LlmClient([ollamaProvider]);
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

      const client = new LlmClient([anthropicProvider, openaiProvider]);
      const result = await client.generate('Say hello');

      expect(result.content).toBe('Hello from OpenAI');
      expect(result.provider).toBe('openai');
      expect(mockAnthropicGenerate).toHaveBeenCalledOnce();
      expect(mockOpenaiGenerate).toHaveBeenCalledOnce();
    });

    it('falls through multiple providers until one succeeds', async () => {
      const { LlmClient } = await freshImport();
      mockAnthropicGenerate.mockRejectedValue(new Error('Down'));
      mockOpenaiGenerate.mockRejectedValue(new Error('Also down'));
      mockGoogleGenerate.mockResolvedValue('Google to the rescue');

      const client = new LlmClient([anthropicProvider, openaiProvider, googleProvider]);
      const result = await client.generate('Help');

      expect(result.content).toBe('Google to the rescue');
      expect(result.provider).toBe('google');
    });
  });

  describe('generate - AllProvidersFailedError', () => {
    it('throws AllProvidersFailedError when all providers fail', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();
      mockAnthropicGenerate.mockRejectedValue(new Error('Fail 1'));
      mockOpenaiGenerate.mockRejectedValue(new Error('Fail 2'));

      const client = new LlmClient([anthropicProvider, openaiProvider]);

      await expect(client.generate('Help')).rejects.toThrow(AllProvidersFailedError);
    });

    it('includes attempted provider names in the error', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();
      mockAnthropicGenerate.mockRejectedValue(new Error('Fail'));
      mockOpenaiGenerate.mockRejectedValue(new Error('Fail'));

      const client = new LlmClient([anthropicProvider, openaiProvider]);

      try {
        await client.generate('Help');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AllProvidersFailedError);
        const allFailed = err as InstanceType<typeof AllProvidersFailedError>;
        expect(allFailed.attempted).toContain('anthropic');
        expect(allFailed.attempted).toContain('openai');
      }
    });

    it('throws AllProvidersFailedError with empty chain', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();

      const client = new LlmClient([]);
      await expect(client.generate('Help')).rejects.toThrow(AllProvidersFailedError);
    });
  });

  describe('generate - circuit breaker skip', () => {
    it('skips a provider whose circuit breaker is open and marks it in attempted', async () => {
      const { LlmClient } = await freshImport();

      // Trip the circuit breaker for anthropic by failing 3 times
      mockAnthropicGenerate.mockRejectedValue(new Error('Fail'));
      mockOpenaiGenerate.mockResolvedValue('OpenAI response');

      const client = new LlmClient([anthropicProvider, openaiProvider]);

      // Fail anthropic 3 times to trip its circuit breaker (threshold=3)
      for (let i = 0; i < 3; i++) {
        await client.generate('Trip breaker');
      }

      // Reset mocks to track the next call
      mockAnthropicGenerate.mockClear();
      mockOpenaiGenerate.mockClear();
      mockOpenaiGenerate.mockResolvedValue('Direct to OpenAI');

      // Now anthropic's circuit should be open; client should skip it
      const result = await client.generate('After breaker trip');

      expect(result.content).toBe('Direct to OpenAI');
      expect(result.provider).toBe('openai');
      // Anthropic should NOT have been called because its circuit is open
      expect(mockAnthropicGenerate).not.toHaveBeenCalled();
    });

    it('marks circuit-open providers in attempted list when all fail', async () => {
      const { LlmClient, AllProvidersFailedError } = await freshImport();

      mockAnthropicGenerate.mockRejectedValue(new Error('Fail'));
      mockOpenaiGenerate.mockRejectedValue(new Error('Fail'));

      const client = new LlmClient([anthropicProvider, openaiProvider]);

      // Both fail 3 times each to trip both breakers
      for (let i = 0; i < 3; i++) {
        try {
          await client.generate('Trip both');
        } catch {
          // expected
        }
      }

      try {
        await client.generate('All open');
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
      const client = new LlmClient([anthropicProvider]);
      expect(client.hasProviders).toBe(true);
    });

    it('returns false when no providers are configured', async () => {
      const { LlmClient } = await freshImport();
      const client = new LlmClient([]);
      expect(client.hasProviders).toBe(false);
    });
  });

  // ── Issue #146 (phase 2a) — generateStream ────────────────────────

  describe('generateStream', () => {
    it('yields chunks from the native streaming provider then a done event', async () => {
      mockAnthropicStream.mockReturnValueOnce(fromChunks(['Hello, ', 'world', '!']));
      const { LlmClient } = await freshImport();
      const client = new LlmClient([anthropicProvider], 'user-1');

      const events: unknown[] = [];
      for await (const e of client.generateStream('hi')) {
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
      const client = new LlmClient([anthropicProvider, openaiProvider], 'user-2');

      const events: unknown[] = [];
      for await (const e of client.generateStream('hi')) {
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
      const client = new LlmClient([anthropicProvider, openaiProvider], 'user-3');

      const events: unknown[] = [];
      let thrown: unknown = null;
      try {
        for await (const e of client.generateStream('hi')) {
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
      const client = new LlmClient([anthropicProvider, openaiProvider], 'user-4');

      let thrown: unknown = null;
      try {
        for await (const _ of client.generateStream('hi')) {
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
      const client = new LlmClient([openaiProvider], 'user-5');

      const events: unknown[] = [];
      for await (const e of client.generateStream('hi')) {
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
      const client = new LlmClient([anthropicProvider], 'user-6');

      const chunks: string[] = [];
      for await (const e of client.generateStream('hi')) {
        if (e.type === 'chunk') chunks.push(e.content);
      }

      expect(chunks).toEqual(['real', 'text']);
    });
  });
});
