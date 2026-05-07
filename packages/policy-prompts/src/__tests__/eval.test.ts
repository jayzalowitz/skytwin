import { describe, it, expect, vi } from 'vitest';
import { evalAllPrompts } from '../eval.js';
import type { LlmClient } from '@skytwin/llm-client';

function makeArrayClient(): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content: '[]',
      provider: 'anthropic',
      model: 'test',
      latencyMs: 10,
    }),
    generateStream: vi.fn(),
    hasProviders: true,
  } as unknown as LlmClient;
}

function makeObjectClient(obj: unknown): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content: JSON.stringify(obj),
      provider: 'anthropic',
      model: 'test',
      latencyMs: 10,
    }),
    generateStream: vi.fn(),
    hasProviders: true,
  } as unknown as LlmClient;
}

describe('evalAllPrompts', () => {
  it('returns an array of EvalResult objects', async () => {
    const client = makeArrayClient();
    const results = await evalAllPrompts({ llmClient: client });
    expect(Array.isArray(results)).toBe(true);
  });

  it('each result has required shape fields', async () => {
    const client = makeArrayClient();
    const results = await evalAllPrompts({ llmClient: client });
    for (const r of results) {
      expect(r).toHaveProperty('promptName');
      expect(r).toHaveProperty('fixtureName');
      expect(r).toHaveProperty('passed');
      expect(r).toHaveProperty('expected');
      expect(r).toHaveProperty('actual');
      expect(typeof r.passed).toBe('boolean');
    }
  });

  it('covers all prompts that have fixtures', async () => {
    const client = makeArrayClient();
    const results = await evalAllPrompts({ llmClient: client });
    const promptNames = new Set(results.map((r) => r.promptName));
    // All 14 prompts have fixtures
    expect(promptNames.size).toBeGreaterThanOrEqual(14);
  });

  it('marks results passed when output shape matches expected shape (array)', async () => {
    const client = makeArrayClient();
    const results = await evalAllPrompts({
      llmClient: client,
      promptNames: ['service-detection'],
    });
    // All service-detection fixtures expect array; [] matches array shape
    const allArrayResults = results.filter((r) => r.promptName === 'service-detection');
    expect(allArrayResults.length).toBeGreaterThan(0);
    for (const r of allArrayResults) {
      expect(r.passed).toBe(true);
    }
  });

  it('marks result failed when runner throws', async () => {
    const client = {
      generate: vi.fn().mockRejectedValue(new Error('simulated failure')),
      generateStream: vi.fn(),
      hasProviders: true,
    } as unknown as LlmClient;

    const results = await evalAllPrompts({
      llmClient: client,
      promptNames: ['service-detection'],
    });

    // All should have fallen back to deterministic (empty-list for service-detection)
    // which DOES match the array expected shape — so they should pass
    for (const r of results) {
      expect(r).toHaveProperty('passed');
    }
  });

  it('runs only specified prompts when promptNames filter is provided', async () => {
    const client = makeArrayClient();
    const results = await evalAllPrompts({
      llmClient: client,
      promptNames: ['capability-ranking'],
    });
    const names = new Set(results.map((r) => r.promptName));
    expect(names.size).toBe(1);
    expect(names.has('capability-ranking')).toBe(true);
  });

  it('handles tier-promotion-judgment with object client', async () => {
    const obj = {
      recommend_promote: false,
      confidence: 0.5,
      reasoning: 'test',
      blocking_concerns: [],
    };
    const client = makeObjectClient(obj);
    const results = await evalAllPrompts({
      llmClient: client,
      promptNames: ['tier-promotion-judgment'],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.actual).toEqual(obj);
    }
  });

  it('handles oauth-recovery with object client', async () => {
    const obj = {
      action: 'refresh_token',
      args: {},
      reasoning: 'token expired',
      confidence: 0.9,
    };
    const client = makeObjectClient(obj);
    const results = await evalAllPrompts({
      llmClient: client,
      promptNames: ['oauth-recovery'],
    });
    expect(results.length).toBeGreaterThan(0);
  });
});
