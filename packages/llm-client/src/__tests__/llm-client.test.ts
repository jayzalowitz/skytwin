import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderEntry } from '../types.js';

// Mock the provider modules. vi.mock is hoisted so these are set up before any imports.
const mockAnthropicGenerate = vi.fn();
const mockOpenaiGenerate = vi.fn();
const mockGoogleGenerate = vi.fn();
const mockOllamaGenerate = vi.fn();

vi.mock('../providers/anthropic.js', () => ({
  generate: (...args: unknown[]) => mockAnthropicGenerate(...args),
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
});
