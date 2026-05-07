/**
 * Tests for the adaptive paths in CapabilityInferenceEngine:
 *   B: service-detection (LLM proposes, registry verifies)
 *   F: capability-ranking (adaptive confidence scores)
 */
import { describe, it, expect, vi } from 'vitest';
import { CapabilityInferenceEngine } from '../inference-engine.js';
import type { SignalLike } from '../types.js';
import type { RegistryClient, RegistryEntry } from '@skytwin/registry-client';
import type { LlmClient } from '@skytwin/llm-client';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(
  id: string,
  displayName: string,
  keywords: string[],
): RegistryEntry {
  return {
    id,
    displayName,
    transport: 'stdio',
    oauthProvider: null,
    category: 'productivity',
    description: `${displayName} service.`,
    keywords,
    verified: 'community',
  };
}

function makeRegistry(entries: RegistryEntry[]): RegistryClient {
  return {
    getAll: vi.fn().mockResolvedValue(entries),
    search: vi.fn(),
    getById: vi.fn(),
    getOAuthQuirks: vi.fn(),
    syncFromSmithery: vi.fn(),
  } as unknown as RegistryClient;
}

function makeSignal(id: string, excerpt: string, kind: SignalLike['kind'] = 'email'): SignalLike {
  return { id, kind, excerpt, occurredAt: new Date() };
}

function makeMockLlmClient(generateFn: () => Promise<{ content: string }>): LlmClient {
  return {
    hasProviders: true,
    generate: vi.fn().mockImplementation(generateFn),
    generateStream: vi.fn(),
  } as unknown as LlmClient;
}

const notionEntry = makeEntry('notion', 'Notion', ['notion', 'notes', 'wiki']);
const slackEntry = makeEntry('slack', 'Slack', ['slack', 'channels']);

// ── service-detection (B) ────────────────────────────────────────────────────

describe('CapabilityInferenceEngine — B: service-detection', () => {
  const signals: SignalLike[] = [
    makeSignal('s1', 'Notion page', 'email'),
    makeSignal('s2', 'slack channel', 'calendar'),
    makeSignal('s3', 'Notion database', 'fs'),
  ];

  // 1. LLM path returns expected output shape
  it('uses LLM-detected services when the prompt returns valid output', async () => {
    const llmClient = makeMockLlmClient(async () => ({
      content: JSON.stringify([
        { name: 'Notion', evidence: [] },
        { name: 'Slack', evidence: [] },
      ]),
    }));

    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry, slackEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
      llmClient,
    });

    const result = await engine.run('u-1', signals);
    // Both notion and slack are in the registry, so both survive verification
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  // 2. LLM failure falls back to deterministic
  it('falls back to deterministic path when LLM throws', async () => {
    const llmClient = makeMockLlmClient(async () => { throw new Error('network error'); });

    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
      llmClient,
    });

    // Signal mentions Notion → deterministic should still find it
    const result = await engine.run('u-1', [makeSignal('s1', 'Notion page', 'email')]);
    expect(result.length).toBe(1);
    expect(result[0]!.registryId).toBe('notion');
  });

  // 3. No LLM client → deterministic path
  it('uses deterministic keyword-match when no llmClient provided', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
    });

    const result = await engine.run('u-1', [makeSignal('s1', 'Notion page', 'email')]);
    expect(result.length).toBe(1);
    expect(result[0]!.registryId).toBe('notion');
  });

  // 4. LLM proposes, registry verifies — hallucinated services are dropped
  it('drops LLM-hallucinated services that are not in the registry', async () => {
    const llmClient = makeMockLlmClient(async () => ({
      content: JSON.stringify([
        { name: 'Notion', evidence: [] },
        { name: 'FakeService123', evidence: [] }, // not in registry
      ]),
    }));

    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
      llmClient,
    });

    const result = await engine.run('u-1', signals);
    const ids = result.map((r) => r.registryId);
    expect(ids).not.toContain('FakeService123');
    expect(ids).not.toContain('fakeservice123');
  });

  // 5. runDeterministic still works as direct API
  it('runDeterministic is callable directly and uses keyword-match', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
    });

    const result = await engine.runDeterministic('u-1', [makeSignal('s1', 'Notion page', 'email')]);
    expect(result.length).toBe(1);
  });
});

// ── capability-ranking (F) ────────────────────────────────────────────────────

describe('CapabilityInferenceEngine — F: capability-ranking', () => {
  // Build two suggestions (bypassing run() by calling rankSuggestions directly)
  const buildSuggestions = () => [
    {
      userId: 'u-1',
      registryId: 'notion',
      displayName: 'Notion',
      evidenceCount: 4,
      evidenceSources: [],
      evidenceKindsDistinct: 3,
      firstEvidenceAt: new Date(),
      lastEvidenceAt: new Date(),
      confidenceScore: 0.7,
      reasonSummary: 'Notion mentioned in emails and calendar.',
    },
    {
      userId: 'u-1',
      registryId: 'slack',
      displayName: 'Slack',
      evidenceCount: 2,
      evidenceSources: [],
      evidenceKindsDistinct: 1,
      firstEvidenceAt: new Date(),
      lastEvidenceAt: new Date(),
      confidenceScore: 0.4,
      reasonSummary: 'Slack mentioned in email.',
    },
  ];

  // 1. LLM ranker returns scores and filters by threshold
  it('reorders suggestions by LLM-assigned score', async () => {
    const llmClient = makeMockLlmClient(async () => ({
      content: JSON.stringify([
        { registryId: 'slack', score: 0.9 }, // LLM ranks Slack higher
        { registryId: 'notion', score: 0.5 },
      ]),
    }));

    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry, slackEntry]),
      llmClient,
    });

    const ranked = await engine.rankSuggestions('u-1', buildSuggestions());
    // Slack should now be first (LLM gave it 0.9)
    expect(ranked[0]!.registryId).toBe('slack');
    expect(ranked[0]!.confidenceScore).toBe(0.9);
  });

  // 2. Suggestions below 0.4 are filtered out
  it('filters out suggestions below the 0.4 adaptive confidence floor', async () => {
    const llmClient = makeMockLlmClient(async () => ({
      content: JSON.stringify([
        { registryId: 'notion', score: 0.5 },
        { registryId: 'slack', score: 0.2 }, // below floor
      ]),
    }));

    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry, slackEntry]),
      llmClient,
    });

    const ranked = await engine.rankSuggestions('u-1', buildSuggestions());
    const ids = ranked.map((r) => r.registryId);
    expect(ids).not.toContain('slack'); // 0.2 < 0.4 floor
    expect(ids).toContain('notion');
  });

  // 3. LLM failure falls back to deterministic evidence-count threshold
  it('falls back to deterministic threshold when LLM throws', async () => {
    const llmClient = makeMockLlmClient(async () => { throw new Error('timeout'); });

    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry, slackEntry]),
      surfacingThreshold: { evidenceCount: 3, kindsDistinct: 2 },
      llmClient,
    });

    const suggestions = buildSuggestions();
    const ranked = await engine.rankSuggestions('u-1', suggestions);
    // Notion: evidenceCount=4, kindsDistinct=3 — passes
    // Slack: evidenceCount=2, kindsDistinct=1 — fails
    const ids = ranked.map((r) => r.registryId);
    expect(ids).toContain('notion');
    expect(ids).not.toContain('slack');
  });

  // 4. No LLM → deterministic evidence-count threshold
  it('uses deterministic threshold when no llmClient provided', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry, slackEntry]),
      surfacingThreshold: { evidenceCount: 3, kindsDistinct: 2 },
    });

    const ranked = await engine.rankSuggestions('u-1', buildSuggestions());
    const ids = ranked.map((r) => r.registryId);
    expect(ids).toContain('notion');
    expect(ids).not.toContain('slack');
  });

  // 5. Empty input → empty output (no LLM call)
  it('returns empty array immediately for empty suggestions', async () => {
    const mockGenerate = vi.fn();
    const llmClient = makeMockLlmClient(async () => ({ content: '[]' }));
    (llmClient.generate as ReturnType<typeof vi.fn>).mockImplementation(mockGenerate);

    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      llmClient,
    });

    const ranked = await engine.rankSuggestions('u-1', []);
    expect(ranked).toHaveLength(0);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
