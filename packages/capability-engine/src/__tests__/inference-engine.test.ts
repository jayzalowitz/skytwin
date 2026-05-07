import { describe, it, expect, vi } from 'vitest';
import { CapabilityInferenceEngine } from '../inference-engine.js';
import type { SignalLike } from '../types.js';
import type { RegistryClient, RegistryEntry } from '@skytwin/registry-client';

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

function makeSignal(
  id: string,
  excerpt: string,
  kind: SignalLike['kind'] = 'email',
  occurredAt: Date = new Date(),
): SignalLike {
  return { id, kind, excerpt, occurredAt };
}

const notionEntry = makeEntry('notion', 'Notion', ['notion', 'notes', 'wiki', 'database']);
const slackEntry = makeEntry('slack', 'Slack', ['slack', 'channels', 'messaging']);

describe('CapabilityInferenceEngine', () => {
  it('emits a suggestion when signals meet the threshold', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 3, kindsDistinct: 2 },
    });
    const signals: SignalLike[] = [
      makeSignal('s1', 'Check the Notion page', 'email', new Date('2024-01-01')),
      makeSignal('s2', 'Updated Notion wiki', 'calendar', new Date('2024-01-02')),
      makeSignal('s3', 'Notion database export', 'fs', new Date('2024-01-03')),
    ];
    const result = await engine.run('u-1', signals);
    expect(result.length).toBe(1);
    expect(result[0]!.registryId).toBe('notion');
  });

  it('does not emit a suggestion for unknown services', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
    });
    const signals = [makeSignal('s1', 'Something about trello boards', 'email')];
    const result = await engine.run('u-1', signals);
    expect(result.length).toBe(0);
  });

  it('does not emit when below evidenceCount threshold', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 3, kindsDistinct: 2 },
    });
    const signals: SignalLike[] = [
      makeSignal('s1', 'Notion page', 'email', new Date('2024-01-01')),
      makeSignal('s2', 'Notion doc', 'calendar', new Date('2024-01-02')),
    ];
    const result = await engine.run('u-1', signals);
    expect(result.length).toBe(0);
  });

  it('does not emit when kindsDistinct threshold is not met', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 3, kindsDistinct: 2 },
    });
    const signals: SignalLike[] = [
      makeSignal('s1', 'Notion', 'email', new Date('2024-01-01')),
      makeSignal('s2', 'Notion', 'email', new Date('2024-01-02')),
      makeSignal('s3', 'Notion', 'email', new Date('2024-01-03')),
    ];
    const result = await engine.run('u-1', signals);
    expect(result.length).toBe(0);
  });

  it('sorts results by confidence descending', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry, slackEntry]),
      surfacingThreshold: { evidenceCount: 2, kindsDistinct: 2 },
    });
    const signals: SignalLike[] = [
      makeSignal('s1', 'Notion notes', 'email', new Date('2024-01-01')),
      makeSignal('s2', 'Notion wiki', 'calendar', new Date('2024-01-02')),
      makeSignal('s3', 'Notion database', 'fs', new Date('2024-01-03')),
      makeSignal('s4', 'Notion page', 'graph_triple', new Date('2024-01-04')),
      makeSignal('s5', 'slack channel', 'email', new Date('2024-01-01')),
      makeSignal('s6', 'slack messaging', 'calendar', new Date('2024-01-02')),
    ];
    const result = await engine.run('u-1', signals);
    expect(result.length).toBe(2);
    expect(result[0]!.confidenceScore).toBeGreaterThanOrEqual(result[1]!.confidenceScore);
  });

  it('does not match "notional" for keyword "notion" (word-boundary)', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
    });
    const signals = [makeSignal('s1', 'notional concept here', 'email')];
    const result = await engine.run('u-1', signals);
    expect(result.length).toBe(0);
  });

  it('matches case-insensitively', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
    });
    const signals = [makeSignal('s1', 'NOTION page updated', 'email')];
    const result = await engine.run('u-1', signals);
    expect(result.length).toBe(1);
  });

  it('matches displayName in addition to keywords', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
    });
    const signals = [makeSignal('s1', 'Notion workspace link', 'email')];
    const result = await engine.run('u-1', signals);
    expect(result.length).toBe(1);
  });

  it('excerpt in evidence sources is capped at 80 chars', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
    });
    const longExcerpt = 'Notion ' + 'x'.repeat(200);
    const signals = [makeSignal('s1', longExcerpt, 'email')];
    const result = await engine.run('u-1', signals);
    expect(result[0]!.evidenceSources[0]!.excerpt.length).toBeLessThanOrEqual(80);
  });

  it('returns empty array when no signals are provided', async () => {
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry]),
    });
    const result = await engine.run('u-1', []);
    expect(result).toHaveLength(0);
  });

  it('handles multiple registry entries with overlapping excerpts correctly', async () => {
    const hybridEntry = makeEntry('notion-slack', 'NotionSlack', ['notion', 'slack']);
    const engine = new CapabilityInferenceEngine({
      registry: makeRegistry([notionEntry, slackEntry, hybridEntry]),
      surfacingThreshold: { evidenceCount: 1, kindsDistinct: 1 },
    });
    const signals = [makeSignal('s1', 'Using notion and slack together', 'email')];
    const result = await engine.run('u-1', signals);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});
