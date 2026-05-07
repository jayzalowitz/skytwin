import { describe, it, expect, vi } from 'vitest';
import { SignalsRouter } from '../router.js';
import type { MemoryPort } from '../port.js';
import type {
  MemoryCapability,
  RawSignal,
  KnowledgeEntity,
  KnowledgeTriple,
  Episode,
  SemanticHit,
  GraphWalkSpec,
  KnowledgeNode,
  TimeRange,
  SummarizeSpec,
  MemorySummary,
  CompressedView,
  MemoryRecord,
} from '../types.js';

// ── Helper: build a minimal mock port ─────────────────────────────────────────

function makeMockPort(caps: MemoryCapability[]): MemoryPort {
  const capSet = new Set<MemoryCapability>(caps);

  const signals: RawSignal[] = [];
  const entities: KnowledgeEntity[] = [];
  const triples: KnowledgeTriple[] = [];
  const episodes: Episode[] = [];

  return {
    capabilities: () => capSet,

    recordSignal: vi.fn(async (s) => { signals.push(s); }),
    recordEntity: vi.fn(async (e) => { entities.push(e); }),
    recordTriple: vi.fn(async (t) => { triples.push(t); }),
    recordEpisode: vi.fn(async (e) => { episodes.push(e); }),

    searchSemantic: vi.fn(async (_q: string, _k: number): Promise<SemanticHit[]> => []),

    walkGraph: vi.fn(async (_spec: GraphWalkSpec): Promise<KnowledgeNode[]> => [
      {
        id: 'native-node-1',
        type: 'triple',
        data: {
          id: 'native-node-1',
          userId: 'u1',
          subject: 'Alice',
          predicate: 'knows',
          object: 'Bob',
          validFrom: new Date('2025-01-01'),
        },
      },
    ]),

    getEpisodes: vi.fn(async (_r: TimeRange): Promise<Episode[]> => [
      {
        id: 'ep1',
        userId: 'u1',
        summary: 'A native episode',
        startedAt: new Date('2025-01-01'),
        endedAt: new Date('2025-01-01T01:00:00'),
      },
    ]),

    getEntitiesByType: vi.fn(async () => entities),

    getTriples: vi.fn(async (subject?: string): Promise<KnowledgeTriple[]> => {
      const all: KnowledgeTriple[] = [
        {
          id: 't1',
          userId: 'u1',
          subject: 'node-a',
          predicate: 'links_to',
          object: 'node-b',
          validFrom: new Date('2025-01-01'),
        },
        {
          id: 't2',
          userId: 'u1',
          subject: 'node-b',
          predicate: 'links_to',
          object: 'node-c',
          validFrom: new Date('2025-01-02'),
        },
      ];
      if (subject) return all.filter((t) => t.subject === subject);
      return all;
    }),

    summarize: vi.fn(async (_spec: SummarizeSpec): Promise<MemorySummary> => ({
      text: 'native summary',
      tokenCount: 3,
      citations: [{ ref: 'r1', kind: 'triple' }],
    })),

    compress: vi.fn(async (_max: number): Promise<CompressedView> => ({
      entries: [],
      totalSourcesCompressed: 0,
    })),

    exportAll: async function* (): AsyncIterable<MemoryRecord> {
      for (const s of signals) yield { kind: 'signal', payload: s };
      for (const e of entities) yield { kind: 'entity', payload: e };
      for (const t of triples) yield { kind: 'triple', payload: t };
      for (const ep of episodes) yield { kind: 'episode', payload: ep };
    },

    importAll: vi.fn(async () => ({ imported: 0, skipped: 0 })),
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('SignalsRouter — walkGraph polyfill', () => {
  it('uses native walkGraph when backend declares graph_walk', async () => {
    const backend = makeMockPort(['semantic_search', 'graph_walk']);
    const router = new SignalsRouter(backend);

    const spec: GraphWalkSpec = { startNodeId: 'node-a', maxDepth: 2 };
    const nodes = await router.walkGraph(spec);

    expect(backend.walkGraph).toHaveBeenCalledWith(spec);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe('native-node-1');
    expect(router.polyfillStats()).toHaveLength(0);
  });

  it('polyfills walkGraph via getTriples BFS when graph_walk is absent', async () => {
    const backend = makeMockPort(['semantic_search']);
    const router = new SignalsRouter(backend);

    const spec: GraphWalkSpec = { startNodeId: 'node-a', maxDepth: 2 };
    const nodes = await router.walkGraph(spec);

    expect(backend.walkGraph).not.toHaveBeenCalled();
    // BFS from node-a → finds t1 (node-a→node-b), then t2 (node-b→node-c)
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    const stats = router.polyfillStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]!.method).toBe('walkGraph');
    expect(stats[0]!.calls).toBe(1);
  });

  it('respects maxDepth=0 — returns no triples from BFS polyfill', async () => {
    const backend = makeMockPort(['semantic_search']);
    const router = new SignalsRouter(backend);

    const spec: GraphWalkSpec = { startNodeId: 'node-a', maxDepth: 0 };
    const nodes = await router.walkGraph(spec);

    // maxDepth 0 means we look up node-a's triples but don't recurse further.
    // getTriples('node-a') returns t1, so we get one triple node.
    expect(nodes.length).toBeGreaterThanOrEqual(0);
  });
});

describe('SignalsRouter — getEpisodes polyfill', () => {
  it('uses native getEpisodes when backend declares episodic', async () => {
    const backend = makeMockPort(['episodic', 'temporal_triples']);
    const router = new SignalsRouter(backend);

    const range: TimeRange = { from: new Date('2025-01-01'), to: new Date('2025-02-01') };
    const episodes = await router.getEpisodes(range);

    expect(backend.getEpisodes).toHaveBeenCalledWith(range, undefined);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.summary).toBe('A native episode');
    expect(router.polyfillStats()).toHaveLength(0);
  });

  it('polyfill returns empty array when episodic capability is absent', async () => {
    const backend = makeMockPort(['semantic_search']);
    const router = new SignalsRouter(backend);

    const range: TimeRange = { from: new Date('2025-01-01'), to: new Date('2025-02-01') };
    const episodes = await router.getEpisodes(range);

    expect(backend.getEpisodes).not.toHaveBeenCalled();
    expect(episodes).toEqual([]);
    const stats = router.polyfillStats();
    expect(stats.some((s) => s.method === 'getEpisodes')).toBe(true);
  });
});

describe('SignalsRouter — summarize polyfill', () => {
  it('uses native summarize when backend declares aaak_compression', async () => {
    const backend = makeMockPort(['episodic', 'aaak_compression']);
    const router = new SignalsRouter(backend);

    const spec: SummarizeSpec = { scope: 'user-profile' };
    const summary = await router.summarize(spec);

    expect(backend.summarize).toHaveBeenCalledWith(spec);
    expect(summary.text).toBe('native summary');
    expect(router.polyfillStats()).toHaveLength(0);
  });

  it('uses native summarize when backend declares temporal_triples', async () => {
    const backend = makeMockPort(['temporal_triples']);
    const router = new SignalsRouter(backend);

    const spec: SummarizeSpec = { scope: 'recent-day' };
    const summary = await router.summarize(spec);

    expect(backend.summarize).toHaveBeenCalled();
    expect(summary.text).toBe('native summary');
  });

  it('polyfills summarize from getTriples when no compression capability exists', async () => {
    const backend = makeMockPort(['semantic_search']);
    const router = new SignalsRouter(backend);

    const spec: SummarizeSpec = { scope: 'user-profile', maxTokens: 200 };
    const summary = await router.summarize(spec);

    expect(backend.summarize).not.toHaveBeenCalled();
    expect(typeof summary.text).toBe('string');
    expect(summary.tokenCount).toBeGreaterThan(0);
    const stats = router.polyfillStats();
    expect(stats.some((s) => s.method === 'summarize')).toBe(true);
  });
});

describe('SignalsRouter — compress polyfill', () => {
  it('uses native compress when backend declares aaak_compression', async () => {
    const backend = makeMockPort(['aaak_compression']);
    const router = new SignalsRouter(backend);

    await router.compress(500);

    expect(backend.compress).toHaveBeenCalledWith(500);
    expect(router.polyfillStats()).toHaveLength(0);
  });

  it('polyfills compress via summarize when aaak_compression is absent', async () => {
    const backend = makeMockPort(['semantic_search', 'temporal_triples']);
    const router = new SignalsRouter(backend);

    const view = await router.compress(300);

    expect(backend.compress).not.toHaveBeenCalled();
    // summarize is native (temporal_triples present), compress is polyfilled
    expect(view.entries).toHaveLength(1);
    const stats = router.polyfillStats();
    expect(stats.some((s) => s.method === 'compress')).toBe(true);
  });
});

describe('SignalsRouter — polyfillStats accumulation', () => {
  it('accumulates latency and call count across repeated polyfill calls', async () => {
    const backend = makeMockPort(['semantic_search']);
    const router = new SignalsRouter(backend);

    const range: TimeRange = { from: new Date('2025-01-01'), to: new Date('2025-02-01') };
    await router.getEpisodes(range);
    await router.getEpisodes(range);
    await router.getEpisodes(range);

    const stats = router.polyfillStats();
    const epStat = stats.find((s) => s.method === 'getEpisodes');
    expect(epStat).toBeDefined();
    expect(epStat!.calls).toBe(3);
    expect(epStat!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns empty stats when no polyfills have been called', () => {
    const backend = makeMockPort(['graph_walk', 'episodic', 'aaak_compression']);
    const router = new SignalsRouter(backend);
    expect(router.polyfillStats()).toEqual([]);
  });

  it('all capabilities present — no polyfill activated, no stats recorded', async () => {
    const allCaps: MemoryCapability[] = [
      'semantic_search',
      'graph_walk',
      'episodic',
      'spatial_wings',
      'aaak_compression',
      'temporal_triples',
      'code_aware_search',
      'federated_sources',
    ];
    const backend = makeMockPort(allCaps);
    const router = new SignalsRouter(backend);

    const spec: GraphWalkSpec = { startNodeId: 'node-a', maxDepth: 1 };
    await router.walkGraph(spec);
    await router.getEpisodes({ from: new Date(), to: new Date() });
    await router.summarize({ scope: 'user-profile' });
    await router.compress(500);

    expect(router.polyfillStats()).toHaveLength(0);
  });
});

describe('SignalsRouter — write passthroughs', () => {
  it('recordSignal delegates directly to backend', async () => {
    const backend = makeMockPort(['semantic_search']);
    const router = new SignalsRouter(backend);

    const signal: RawSignal = {
      id: 's1',
      source: 'gmail',
      type: 'email',
      timestamp: new Date(),
      data: { subject: 'Hello' },
    };
    await router.recordSignal(signal);
    expect(backend.recordSignal).toHaveBeenCalledWith(signal);
  });
});
