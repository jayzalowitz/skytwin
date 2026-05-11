import { describe, it, expect, vi } from 'vitest';
import { HybridMemoryPort } from '../hybrid-port.js';
import type {
  MemoryPort,
  MemoryCapability,
  KnowledgeNode,
  Episode,
  SemanticHit,
  MemoryRecord,
} from '@skytwin/memory-port';

function makeMockPort(caps: Set<MemoryCapability> = new Set()): MemoryPort {
  return {
    capabilities: () => caps,
    recordSignal: vi.fn(async () => undefined),
    recordEntity: vi.fn(async () => undefined),
    recordTriple: vi.fn(async () => undefined),
    recordEpisode: vi.fn(async () => undefined),
    searchSemantic: vi.fn(async (): Promise<SemanticHit[]> => []),
    walkGraph: vi.fn(async (): Promise<KnowledgeNode[]> => []),
    getEpisodes: vi.fn(async (): Promise<Episode[]> => []),
    getEntitiesByType: vi.fn(async () => []),
    getTriples: vi.fn(async () => []),
    summarize: vi.fn(async () => ({ text: '', tokenCount: 0, citations: [] })),
    compress: vi.fn(async () => ({ entries: [], totalSourcesCompressed: 0 })),
    exportAll: vi.fn(async function* (): AsyncGenerator<MemoryRecord, void, unknown> {}),
    importAll: vi.fn(async () => ({ imported: 0, skipped: 0 })),
  };
}

describe('HybridMemoryPort — diagnostics counters', () => {
  it('starts with zero counters', () => {
    const hybrid = new HybridMemoryPort({
      primary: makeMockPort(new Set(['semantic_search'])),
      secondary: makeMockPort(new Set(['episodic'])),
    });
    expect(hybrid.getDiagnostics()).toEqual({
      routedPrimary: 0,
      routedSecondary: 0,
      writesPrimaryOk: 0,
      writesSecondaryOk: 0,
      writesSecondaryFailed: 0,
      writesPrimaryFailed: 0,
    });
  });

  it('increments routedPrimary on capability-matched primary read', async () => {
    const hybrid = new HybridMemoryPort({
      primary: makeMockPort(new Set(['semantic_search'])),
      secondary: makeMockPort(new Set(['episodic'])),
    });
    await hybrid.searchSemantic('q', 5);
    const d = hybrid.getDiagnostics();
    expect(d.routedPrimary).toBe(1);
    expect(d.routedSecondary).toBe(0);
  });

  it('increments routedSecondary when primary lacks capability', async () => {
    const hybrid = new HybridMemoryPort({
      primary: makeMockPort(new Set()),
      secondary: makeMockPort(new Set(['semantic_search'])),
    });
    await hybrid.searchSemantic('q', 5);
    const d = hybrid.getDiagnostics();
    expect(d.routedPrimary).toBe(0);
    expect(d.routedSecondary).toBe(1);
  });

  it('counts write outcomes (both ok)', async () => {
    const hybrid = new HybridMemoryPort({
      primary: makeMockPort(new Set(['semantic_search'])),
      secondary: makeMockPort(new Set(['episodic'])),
    });
    await hybrid.recordSignal({
      id: 's1',
      source: 'g',
      type: 'e',
      timestamp: new Date(),
      data: {},
    });
    const d = hybrid.getDiagnostics();
    expect(d.writesPrimaryOk).toBe(1);
    expect(d.writesSecondaryOk).toBe(1);
    expect(d.writesPrimaryFailed).toBe(0);
    expect(d.writesSecondaryFailed).toBe(0);
  });

  it('counts secondary write failure', async () => {
    const secondary = makeMockPort(new Set(['episodic']));
    (secondary.recordSignal as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('secondary down'),
    );
    const hybrid = new HybridMemoryPort({
      primary: makeMockPort(new Set(['semantic_search'])),
      secondary,
    });
    await hybrid.recordSignal({
      id: 's1',
      source: 'g',
      type: 'e',
      timestamp: new Date(),
      data: {},
    });
    const d = hybrid.getDiagnostics();
    expect(d.writesPrimaryOk).toBe(1);
    expect(d.writesSecondaryFailed).toBe(1);
    expect(d.writesSecondaryOk).toBe(0);
  });

  it('counts primary write failure (and rethrows)', async () => {
    const primary = makeMockPort(new Set(['semantic_search']));
    (primary.recordSignal as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('primary down'),
    );
    const hybrid = new HybridMemoryPort({
      primary,
      secondary: makeMockPort(new Set(['episodic'])),
    });
    await expect(
      hybrid.recordSignal({
        id: 's1',
        source: 'g',
        type: 'e',
        timestamp: new Date(),
        data: {},
      }),
    ).rejects.toThrow(/primary down/);
    const d = hybrid.getDiagnostics();
    expect(d.writesPrimaryFailed).toBe(1);
    // Secondary not attempted because primary throws first.
    expect(d.writesSecondaryOk).toBe(0);
  });

  it('resetDiagnostics zeroes all counters', async () => {
    const hybrid = new HybridMemoryPort({
      primary: makeMockPort(new Set(['semantic_search'])),
      secondary: makeMockPort(new Set(['episodic'])),
    });
    await hybrid.searchSemantic('q', 5);
    await hybrid.recordSignal({
      id: 's1',
      source: 'g',
      type: 'e',
      timestamp: new Date(),
      data: {},
    });
    expect(hybrid.getDiagnostics().routedPrimary).toBeGreaterThan(0);
    hybrid.resetDiagnostics();
    expect(hybrid.getDiagnostics()).toEqual({
      routedPrimary: 0,
      routedSecondary: 0,
      writesPrimaryOk: 0,
      writesSecondaryOk: 0,
      writesSecondaryFailed: 0,
      writesPrimaryFailed: 0,
    });
  });

  it('getDiagnostics returns a defensive copy', () => {
    const hybrid = new HybridMemoryPort({
      primary: makeMockPort(),
      secondary: makeMockPort(),
    });
    const d = hybrid.getDiagnostics();
    d.routedPrimary = 999;
    expect(hybrid.getDiagnostics().routedPrimary).toBe(0);
  });
});

describe('HybridMemoryPort — fallback when primary lacks capability', () => {
  it('walkGraph routes to secondary when configured "primary" but primary lacks graph_walk', async () => {
    // routing override: walkGraph→primary, but primary doesn't have graph_walk.
    const primary = makeMockPort(new Set(['semantic_search']));
    const secondary = makeMockPort(new Set(['graph_walk']));
    const hybrid = new HybridMemoryPort({
      primary,
      secondary,
      routing: { walkGraph: 'primary' },
    });
    await hybrid.walkGraph({ startNodeId: 'n', maxDepth: 1 });
    expect(secondary.walkGraph).toHaveBeenCalledTimes(1);
    expect(primary.walkGraph).not.toHaveBeenCalled();
  });
});
