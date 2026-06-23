import { describe, it, expect, vi } from 'vitest';
import { HybridMemoryPort } from '../hybrid-port.js';
import type { MemoryPort, SemanticHit, KnowledgeNode, Episode, MemoryRecord } from '@skytwin/memory-port';
import type { MemPalaceMemoryPort } from '@skytwin/memory-mempalace';

// ── Helpers ────────────────────────────────────────────────────────────────

type MockFn = ReturnType<typeof vi.fn>;

/**
 * Build a minimal MemoryPort double. Each method is a vi.fn() typed as the
 * correct MemoryPort method signature. We cast the assembled object to
 * `MemoryPort` via `as unknown` so strict mode doesn't fight us on the
 * return-type positions of vi.fn().
 */
function makeMockPort(capSet: Set<string> = new Set()): MemoryPort {
  const port = {
    capabilities: vi.fn().mockReturnValue(capSet),
    recordSignal: vi.fn(async (_signal: Parameters<MemoryPort['recordSignal']>[0]) => undefined),
    recordEntity: vi.fn(async (_entity: Parameters<MemoryPort['recordEntity']>[0]) => undefined),
    recordTriple: vi.fn(async (_triple: Parameters<MemoryPort['recordTriple']>[0]) => undefined),
    recordEpisode: vi.fn(async (_episode: Parameters<MemoryPort['recordEpisode']>[0]) => undefined),
    searchSemantic: vi.fn(async (_query: string, _k: number): Promise<SemanticHit[]> => []),
    walkGraph: vi.fn(async (_spec: Parameters<MemoryPort['walkGraph']>[0]): Promise<KnowledgeNode[]> => []),
    getEpisodes: vi.fn(async (_range: Parameters<MemoryPort['getEpisodes']>[0]): Promise<Episode[]> => []),
    getEntitiesByType: vi.fn().mockResolvedValue([]),
    getTriples: vi.fn().mockResolvedValue([]),
    summarize: vi.fn().mockResolvedValue({ text: '', tokenCount: 0, citations: [] }),
    compress: vi.fn().mockResolvedValue({ entries: [], totalSourcesCompressed: 0 }),
    exportAll: vi.fn(async function* (): AsyncGenerator<MemoryRecord, void, unknown> {}),
    importAll: vi.fn().mockResolvedValue({ imported: 0, skipped: 0 }),
  };
  return port as unknown as MemoryPort;
}

/** Helper to access mock fns on a port returned by makeMockPort. */
function fn(port: MemoryPort, method: keyof MemoryPort): MockFn {
  return (port as unknown as Record<keyof MemoryPort, MockFn>)[method];
}

// Compile-time verification: MemPalaceMemoryPort must satisfy MemoryPort.
// This type-level assertion causes a tsc error if the shapes diverge.
// It is erased at runtime.
type _MemPalaceIsMemoryPort = MemPalaceMemoryPort extends MemoryPort ? true : false;
const _check: _MemPalaceIsMemoryPort = true;
void _check;

// ── Tests ──────────────────────────────────────────────────────────────────

describe('HybridMemoryPort', () => {
  describe('routing — reads', () => {
    it('routes searchSemantic to primary when primary declares semantic_search', async () => {
      const primary = makeMockPort(new Set(['semantic_search', 'code_aware_search']));
      const secondary = makeMockPort(new Set(['episodic', 'graph_walk']));
      const hybrid = new HybridMemoryPort({ primary, secondary });

      const hits: SemanticHit[] = [{ id: 'h1', score: 0.9, content: 'x', source: 'f.ts' }];
      fn(primary, 'searchSemantic').mockResolvedValue(hits);

      const result = await hybrid.searchSemantic('query', 5);
      expect(result).toEqual(hits);
      expect(fn(primary, 'searchSemantic')).toHaveBeenCalledTimes(1);
      expect(fn(secondary, 'searchSemantic')).not.toHaveBeenCalled();
    });

    it('falls back searchSemantic to secondary when primary lacks semantic_search', async () => {
      const primary = makeMockPort(new Set<string>()); // no capabilities
      const secondary = makeMockPort(new Set(['semantic_search']));
      const hybrid = new HybridMemoryPort({ primary, secondary });

      await hybrid.searchSemantic('query', 5);
      expect(fn(secondary, 'searchSemantic')).toHaveBeenCalledTimes(1);
      expect(fn(primary, 'searchSemantic')).not.toHaveBeenCalled();
    });

    it('routes walkGraph to secondary by default', async () => {
      const primary = makeMockPort(new Set(['semantic_search']));
      const secondary = makeMockPort(new Set(['graph_walk']));
      const hybrid = new HybridMemoryPort({ primary, secondary });

      const nodes: KnowledgeNode[] = [];
      fn(secondary, 'walkGraph').mockResolvedValue(nodes);

      await hybrid.walkGraph({ startNodeId: 'n1', maxDepth: 2 });
      expect(fn(secondary, 'walkGraph')).toHaveBeenCalledTimes(1);
      expect(fn(primary, 'walkGraph')).not.toHaveBeenCalled();
    });

    it('routes getEpisodes to secondary by default', async () => {
      const primary = makeMockPort(new Set(['semantic_search']));
      const secondary = makeMockPort(new Set(['episodic']));
      const hybrid = new HybridMemoryPort({ primary, secondary });

      const range = { from: new Date(0), to: new Date() };
      await hybrid.getEpisodes(range);
      expect(fn(secondary, 'getEpisodes')).toHaveBeenCalledWith(range, undefined);
      expect(fn(primary, 'getEpisodes')).not.toHaveBeenCalled();
    });

    it('overrides routing via RoutingRules option', async () => {
      const primary = makeMockPort(new Set(['semantic_search', 'graph_walk']));
      const secondary = makeMockPort(new Set(['graph_walk']));
      const hybrid = new HybridMemoryPort({
        primary,
        secondary,
        routing: { walkGraph: 'primary' },
      });

      await hybrid.walkGraph({ startNodeId: 'n1', maxDepth: 1 });
      expect(fn(primary, 'walkGraph')).toHaveBeenCalledTimes(1);
      expect(fn(secondary, 'walkGraph')).not.toHaveBeenCalled();
    });
  });

  describe('writes — dual-write semantics', () => {
    it('writes recordSignal to both primary and secondary', async () => {
      const primary = makeMockPort(new Set(['semantic_search']));
      const secondary = makeMockPort(new Set(['episodic']));
      const hybrid = new HybridMemoryPort({ primary, secondary });

      const signal = { id: 's1', source: 'test', type: 'raw', timestamp: new Date(), data: {} };
      await hybrid.recordSignal(signal);

      expect(fn(primary, 'recordSignal')).toHaveBeenCalledWith(signal);
      expect(fn(secondary, 'recordSignal')).toHaveBeenCalledWith(signal);
    });

    it('secondary write failure does not fail the operation', async () => {
      const primary = makeMockPort(new Set(['semantic_search']));
      const secondary = makeMockPort(new Set(['episodic']));
      fn(secondary, 'recordSignal').mockRejectedValue(new Error('secondary is down'));

      const hybrid = new HybridMemoryPort({ primary, secondary });

      const signal = { id: 's2', source: 'test', type: 'raw', timestamp: new Date(), data: {} };
      await expect(hybrid.recordSignal(signal)).resolves.toBeUndefined();
      expect(fn(primary, 'recordSignal')).toHaveBeenCalledWith(signal);
    });

    it('primary write failure propagates normally', async () => {
      const primary = makeMockPort(new Set(['semantic_search']));
      const secondary = makeMockPort(new Set(['episodic']));
      fn(primary, 'recordSignal').mockRejectedValue(new Error('primary is down'));

      const hybrid = new HybridMemoryPort({ primary, secondary });

      const signal = { id: 's3', source: 'test', type: 'raw', timestamp: new Date(), data: {} };
      await expect(hybrid.recordSignal(signal)).rejects.toThrow('primary is down');
    });
  });

  describe('capabilities()', () => {
    it('returns union of primary and secondary capabilities', () => {
      const primary = makeMockPort(new Set(['semantic_search', 'code_aware_search']));
      const secondary = makeMockPort(new Set(['episodic', 'graph_walk', 'temporal_triples']));
      const hybrid = new HybridMemoryPort({ primary, secondary });

      const caps = hybrid.capabilities();
      expect(caps.has('semantic_search')).toBe(true);
      expect(caps.has('code_aware_search')).toBe(true);
      expect(caps.has('episodic')).toBe(true);
      expect(caps.has('graph_walk')).toBe(true);
      expect(caps.has('temporal_triples')).toBe(true);
    });
  });

  describe('migration', () => {
    it('exportAll delegates to secondary only', async () => {
      const primary = makeMockPort(new Set(['semantic_search']));
      const secondary = makeMockPort(new Set(['episodic']));

      async function* fakeExport(): AsyncGenerator<MemoryRecord, void, unknown> {
        yield { kind: 'signal', payload: { id: 'x', source: 's', type: 't', timestamp: new Date(), data: {} } };
      }
      fn(secondary, 'exportAll').mockReturnValue(fakeExport());

      const hybrid = new HybridMemoryPort({ primary, secondary });

      const records: MemoryRecord[] = [];
      for await (const r of hybrid.exportAll()) {
        records.push(r);
      }
      expect(records).toHaveLength(1);
      expect(fn(primary, 'exportAll')).not.toHaveBeenCalled();
    });
  });
});
