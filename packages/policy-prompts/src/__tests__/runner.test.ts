import { describe, it, expect, vi } from 'vitest';
import { runPrompt } from '../runner.js';
import { InMemoryPromptCache } from '../cache.js';
import type { LlmClient } from '@skytwin/llm-client';
import type { BudgetTracker } from '../types.js';

function makeMockLlmClient(responseText: string): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content: responseText,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      latencyMs: 50,
    }),
    generateStream: vi.fn(),
    hasProviders: true,
  } as unknown as LlmClient;
}

function makeBudgetTracker(hasBudget = true): BudgetTracker {
  return {
    hasBudget: vi.fn().mockResolvedValue(hasBudget),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('runPrompt', () => {
  describe('template rendering', () => {
    it('interpolates {{vars}} in the template body', async () => {
      const client = makeMockLlmClient(JSON.stringify([{ name: 'Notion', evidence: [{source: 'email', ref: 'r1', excerpt: 'notion page'}] }]));
      await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[{"source":"email","ref":"r1","text":"notion page"}]', risk_profile: 'Standard' },
        user: { userId: 'u1' },
        llmClient: client,
      });
      const calledWith = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(calledWith).toContain('notion page');
    });

    it('leaves unmatched {{vars}} as-is in rendered prompt', async () => {
      const client = makeMockLlmClient('[]');
      await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: 'test-signal' },
        user: { userId: 'u2' },
        llmClient: client,
      });
      const rendered = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      // risk_profile not provided; placeholder should remain
      expect(rendered).toContain('{{risk_profile}}');
    });
  });

  describe('cache behavior', () => {
    it('returns cached result on second call (same inputs)', async () => {
      const client = makeMockLlmClient('[]');
      const cache = new InMemoryPromptCache();

      await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'test' },
        user: { userId: 'u3' },
        llmClient: client,
        cache,
      });
      const second = await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'test' },
        user: { userId: 'u3' },
        llmClient: client,
        cache,
      });

      expect(second.cached).toBe(true);
      expect((client.generate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it('does not use cache when inputs differ', async () => {
      const client = makeMockLlmClient('[]');
      const cache = new InMemoryPromptCache();

      await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'a' },
        user: { userId: 'u4' },
        llmClient: client,
        cache,
      });
      await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'b' },
        user: { userId: 'u4' },
        llmClient: client,
        cache,
      });

      expect((client.generate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });
  });

  describe('budget tracking', () => {
    it('falls back to deterministic when budget exhausted', async () => {
      const client = makeMockLlmClient('[]');
      const tracker = makeBudgetTracker(false);

      const result = await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'test' },
        user: { userId: 'u5' },
        llmClient: client,
        budgetTracker: tracker,
      });

      expect(result.fellBackToDeterministic).toBe(true);
      expect(result.output).toEqual([]); // empty-list fallback
      expect((client.generate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('records usage after successful generation', async () => {
      const client = makeMockLlmClient('[]');
      const tracker = makeBudgetTracker(true);

      await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'test' },
        user: { userId: 'u6' },
        llmClient: client,
        budgetTracker: tracker,
      });

      expect(tracker.recordUsage).toHaveBeenCalledOnce();
      expect(tracker.recordUsage).toHaveBeenCalledWith('u6', 'service-detection', expect.any(Number));
    });
  });

  describe('schema validation and retry', () => {
    it('retries once on schema validation failure and falls back on persistent failure', async () => {
      // Return invalid schema both times
      const client = {
        generate: vi.fn().mockResolvedValue({
          content: '"not-an-array"',
          provider: 'anthropic',
          model: 'test',
          latencyMs: 10,
        }),
        generateStream: vi.fn(),
        hasProviders: true,
      } as unknown as LlmClient;

      const result = await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'test' },
        user: { userId: 'u7' },
        llmClient: client,
      });

      expect(result.fellBackToDeterministic).toBe(true);
      expect((client.generate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it('succeeds when second attempt returns valid schema', async () => {
      let calls = 0;
      const client = {
        generate: vi.fn().mockImplementation(() => {
          calls++;
          return Promise.resolve({
            content: calls === 1 ? '"bad"' : '[]',
            provider: 'anthropic',
            model: 'test',
            latencyMs: 10,
          });
        }),
        generateStream: vi.fn(),
        hasProviders: true,
      } as unknown as LlmClient;

      const result = await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'test' },
        user: { userId: 'u8' },
        llmClient: client,
      });

      expect(result.fellBackToDeterministic).toBe(false);
      expect(result.output).toEqual([]);
    });

    it('falls back on LlmClient exception', async () => {
      const client = {
        generate: vi.fn().mockRejectedValue(new Error('provider failure')),
        generateStream: vi.fn(),
        hasProviders: true,
      } as unknown as LlmClient;

      const result = await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'test' },
        user: { userId: 'u9' },
        llmClient: client,
      });

      expect(result.fellBackToDeterministic).toBe(true);
    });
  });

  describe('deterministic fallback strategies', () => {
    it('returns [] for empty-list strategy', async () => {
      const client = makeMockLlmClient('[]');
      const tracker = makeBudgetTracker(false);
      const result = await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'test' },
        user: { userId: 'uf1' },
        llmClient: client,
        budgetTracker: tracker,
      });
      expect(result.output).toEqual([]);
    });

    it('returns inputs for pass-through strategy', async () => {
      const client = makeMockLlmClient('');
      const tracker = makeBudgetTracker(false);
      const inputs = { text: 'hello', language: 'en', risk_profile: '' };
      const result = await runPrompt({
        promptName: 'humanize-copy',
        inputs,
        user: { userId: 'uf2' },
        llmClient: client,
        budgetTracker: tracker,
      });
      expect(result.output).toEqual(inputs);
    });
  });

  describe('latency measurement', () => {
    it('returns a positive latencyMs', async () => {
      const client = makeMockLlmClient('[]');
      const result = await runPrompt({
        promptName: 'service-detection',
        inputs: { signals: '[]', risk_profile: 'test' },
        user: { userId: 'ul1' },
        llmClient: client,
      });
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
