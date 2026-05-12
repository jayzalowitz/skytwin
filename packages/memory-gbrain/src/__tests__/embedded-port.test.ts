import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddedGbrainMemoryPort } from '../embedded-port.js';
import {
  InMemoryBrainStore,
  HashEmbeddingProvider,
} from '@skytwin/memory-gbrain-crdb-adapter';
import type {
  RawSignal,
  KnowledgeEntity,
  KnowledgeTriple,
  Episode,
  MemoryRecord,
} from '@skytwin/memory-port';

const USER = 'user-1';

describe('EmbeddedGbrainMemoryPort — capabilities', () => {
  it('declares the gbrain capability set (no spatial_wings, no aaak)', () => {
    const port = new EmbeddedGbrainMemoryPort({ userId: USER, backend: 'memory' });
    const caps = port.capabilities();
    expect(caps.has('semantic_search')).toBe(true);
    expect(caps.has('code_aware_search')).toBe(true);
    expect(caps.has('temporal_triples')).toBe(true);
    expect(caps.has('episodic')).toBe(true);
    expect(caps.has('graph_walk')).toBe(true);
    expect(caps.has('spatial_wings')).toBe(false);
    expect(caps.has('aaak_compression')).toBe(false);
  });

  it('throws on missing userId at construction', () => {
    expect(() => new EmbeddedGbrainMemoryPort({ userId: '', backend: 'memory' })).toThrow(/userId/);
  });
});

describe('EmbeddedGbrainMemoryPort — recordSignal', () => {
  let store: InMemoryBrainStore;
  let port: EmbeddedGbrainMemoryPort;

  beforeEach(() => {
    store = new InMemoryBrainStore();
    port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(64),
    });
  });

  it('persists the signal AND indexes a brain page for it', async () => {
    const sig: RawSignal = {
      id: 'sig-1',
      source: 'gmail',
      type: 'email',
      timestamp: new Date('2026-05-01'),
      data: { subject: 'Q2 board agenda', from: 'chair@board.example.com' },
    };
    await port.recordSignal(sig);
    expect(store.getAllSignals(USER)).toHaveLength(1);
    expect(store.countPages(USER).total).toBe(1);
    expect(store.countPages(USER).embedded).toBe(1); // synchronous embedding
  });

  it('rejects duplicate signal ids', async () => {
    const sig: RawSignal = {
      id: 'sig-1',
      source: 'gmail',
      type: 'email',
      timestamp: new Date(),
      data: {},
    };
    await port.recordSignal(sig);
    await expect(port.recordSignal(sig)).rejects.toThrow(/duplicate/);
  });

  // #251 Layer 1: when a connector stamps `data.authoringTier`, the embedded
  // port projects it onto `brain_pages.metadata.authoringTier` so Layer 2
  // retrieval weighting can read it without a join back to the signal row.
  it('projects data.authoringTier onto brain_pages.metadata', async () => {
    const sig: RawSignal = {
      id: 'sig-tier',
      source: 'gmail',
      type: 'email',
      timestamp: new Date('2026-05-01'),
      data: {
        subject: 'Re: Q2 plan',
        from: 'me@example.com',
        authoringTier: 'user_sent_reply',
      },
    };
    await port.recordSignal(sig);
    const pages = store.getAllPages(USER);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.metadata).toMatchObject({
      signalSource: 'gmail',
      signalType: 'email',
      authoringTier: 'user_sent_reply',
    });
  });

  it('omits authoringTier from metadata when the connector did not stamp one', async () => {
    const sig: RawSignal = {
      id: 'sig-no-tier',
      source: 'cal',
      type: 'event',
      timestamp: new Date('2026-05-01'),
      data: { subject: 'Lunch' },
    };
    await port.recordSignal(sig);
    const pages = store.getAllPages(USER);
    expect(pages).toHaveLength(1);
    const meta = pages[0]!.metadata as Record<string, unknown>;
    expect(meta['signalSource']).toBe('cal');
    expect(meta['signalType']).toBe('event');
    // bodyLen is always stamped for the brief-reply downweight (#251 Layer 2).
    expect(typeof meta['bodyLen']).toBe('number');
    expect(meta['authoringTier']).toBeUndefined();
  });

  it('ignores non-string authoringTier values defensively', async () => {
    const sig: RawSignal = {
      id: 'sig-bad-tier',
      source: 'gmail',
      type: 'email',
      timestamp: new Date('2026-05-01'),
      data: {
        subject: 'X',
        // Deliberately wrong shape to exercise the defensive non-string check
        // in buildPageMetadata. `data: Record<string, unknown>` accepts this.
        authoringTier: 42,
      },
    };
    await port.recordSignal(sig);
    const pages = store.getAllPages(USER);
    expect((pages[0]!.metadata as Record<string, unknown>)['authoringTier']).toBeUndefined();
  });
});

describe('EmbeddedGbrainMemoryPort — searchSemantic', () => {
  let port: EmbeddedGbrainMemoryPort;
  let store: InMemoryBrainStore;

  beforeEach(async () => {
    store = new InMemoryBrainStore();
    port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(128),
    });

    const signals: RawSignal[] = [
      {
        id: 's1',
        source: 'gmail',
        type: 'email',
        timestamp: new Date('2026-04-01'),
        data: { subject: 'Q2 budget review meeting Tuesday', from: 'cfo@example.com' },
      },
      {
        id: 's2',
        source: 'cal',
        type: 'event',
        timestamp: new Date('2026-04-02'),
        data: { subject: 'Database migration planning' },
      },
      {
        id: 's3',
        source: 'gmail',
        type: 'email',
        timestamp: new Date('2026-04-03'),
        data: { subject: 'Tuesday standup notes' },
      },
    ];
    for (const s of signals) await port.recordSignal(s);
  });

  it('returns hits ordered by relevance', async () => {
    const hits = await port.searchSemantic('budget meeting Tuesday', 5);
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.content.toLowerCase()).toMatch(/budget|tuesday|meeting/);
  });

  it('returns [] for empty query', async () => {
    expect(await port.searchSemantic('', 5)).toEqual([]);
    expect(await port.searchSemantic('   ', 5)).toEqual([]);
  });

  it('limits to k results', async () => {
    const hits = await port.searchSemantic('Tuesday meeting', 1);
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it('sets metadata.source on returned hits', async () => {
    const hits = await port.searchSemantic('Tuesday', 5);
    expect(hits[0]?.source).toBe('signal');
  });
});

describe('EmbeddedGbrainMemoryPort — code-aware search', () => {
  it('boosts code-tagged pages over equally-relevant non-code pages', async () => {
    const store = new InMemoryBrainStore();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(64),
    });
    const emb = new HashEmbeddingProvider(64);
    const codeEmb = await emb.embed('process signal handler');
    const noteEmb = await emb.embed('process signal handler');
    store.insertPage({
      userId: USER,
      content: 'process signal handler logic',
      source: 'code',
      embedding: codeEmb,
      embeddingModel: 'h',
    });
    store.insertPage({
      userId: USER,
      content: 'process signal handler logic',
      source: 'note',
      embedding: noteEmb,
      embeddingModel: 'h',
    });
    const hits = await port.searchCodeAware('process signal', 5);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.source).toBe('code');
    expect(hits[1]?.source).toBe('note');
  });
});

describe('EmbeddedGbrainMemoryPort — entities + triples', () => {
  let store: InMemoryBrainStore;
  let port: EmbeddedGbrainMemoryPort;

  beforeEach(() => {
    store = new InMemoryBrainStore();
    port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(64),
    });
  });

  it('records and retrieves entities by type', async () => {
    const e: KnowledgeEntity = {
      id: 'ent-1',
      userId: USER,
      name: 'Alice',
      entityType: 'person',
      attributes: { email: 'alice@example.com' },
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    };
    await port.recordEntity(e);
    const list = await port.getEntitiesByType('person');
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Alice');
  });

  it('records and queries triples', async () => {
    const t: KnowledgeTriple = {
      id: 'tr-1',
      userId: USER,
      subject: 'alice',
      predicate: 'works_at',
      object: 'acme',
      validFrom: new Date('2026-01-01'),
    };
    await port.recordTriple(t);
    const queried = await port.getTriples('alice');
    expect(queried).toHaveLength(1);
    expect(queried[0]?.predicate).toBe('works_at');
  });

  it('walkGraph BFS traverses the triple graph', async () => {
    await port.recordTriple({
      id: 't1',
      userId: USER,
      subject: 'a',
      predicate: 'leads_to',
      object: 'b',
      validFrom: new Date(),
    });
    await port.recordTriple({
      id: 't2',
      userId: USER,
      subject: 'b',
      predicate: 'leads_to',
      object: 'c',
      validFrom: new Date(),
    });
    const nodes = await port.walkGraph({ startNodeId: 'a', maxDepth: 2 });
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('t1');
    expect(ids).toContain('t2');
  });

  it('walkGraph respects maxDepth', async () => {
    await port.recordTriple({
      id: 't1',
      userId: USER,
      subject: 'a',
      predicate: 'leads_to',
      object: 'b',
      validFrom: new Date(),
    });
    await port.recordTriple({
      id: 't2',
      userId: USER,
      subject: 'b',
      predicate: 'leads_to',
      object: 'c',
      validFrom: new Date(),
    });
    const nodes = await port.walkGraph({ startNodeId: 'a', maxDepth: 0 });
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('t1');
    expect(ids).not.toContain('t2');
  });
});

describe('EmbeddedGbrainMemoryPort — episodes', () => {
  it('records and filters episodes', async () => {
    const store = new InMemoryBrainStore();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(64),
    });
    const ep: Episode = {
      id: 'ep-1',
      userId: USER,
      wing: 'work',
      summary: 'Reviewed Q2 forecast',
      startedAt: new Date('2026-04-01T10:00:00Z'),
      endedAt: new Date('2026-04-01T11:00:00Z'),
    };
    await port.recordEpisode(ep);
    const list = await port.getEpisodes({
      from: new Date('2026-03-01'),
      to: new Date('2026-05-01'),
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.wing).toBe('work');
  });

  it('filters by minDurationMs', async () => {
    const store = new InMemoryBrainStore();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(64),
    });
    await port.recordEpisode({
      id: 'short',
      userId: USER,
      summary: 'short ep',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-01T00:00:30Z'),
    });
    await port.recordEpisode({
      id: 'long',
      userId: USER,
      summary: 'long ep',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-01T01:00:00Z'),
    });
    const filtered = await port.getEpisodes(
      { from: new Date('2025-01-01'), to: new Date('2027-01-01') },
      { minDurationMs: 60_000 },
    );
    expect(filtered.map((e) => e.id)).toEqual(['long']);
  });
});

describe('EmbeddedGbrainMemoryPort — export/import round-trip', () => {
  it('round-trips signals + entities + triples + episodes losslessly', async () => {
    const sourceStore = new InMemoryBrainStore();
    const sourcePort = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store: sourceStore,
      embedding: new HashEmbeddingProvider(64),
    });

    await sourcePort.recordSignal({
      id: 's1',
      source: 'gmail',
      type: 'email',
      timestamp: new Date('2026-01-01'),
      data: { subject: 'hi' },
    });
    await sourcePort.recordEntity({
      id: 'e1',
      userId: USER,
      name: 'Alice',
      entityType: 'person',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });
    await sourcePort.recordTriple({
      id: 't1',
      userId: USER,
      subject: 'alice',
      predicate: 'knows',
      object: 'bob',
      validFrom: new Date(),
    });
    await sourcePort.recordEpisode({
      id: 'ep1',
      userId: USER,
      summary: 'review',
      startedAt: new Date('2026-01-01'),
      endedAt: new Date('2026-01-01T01:00:00Z'),
    });

    const exported: MemoryRecord[] = [];
    for await (const r of sourcePort.exportAll()) exported.push(r);
    expect(exported.map((r) => r.kind)).toEqual(['signal', 'entity', 'triple', 'episode']);

    // Import into a fresh store and verify symmetry.
    const targetStore = new InMemoryBrainStore();
    const targetPort = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store: targetStore,
      embedding: new HashEmbeddingProvider(64),
    });
    async function* gen(): AsyncIterable<MemoryRecord> {
      for (const r of exported) yield r;
    }
    const summary = await targetPort.importAll(gen());
    expect(summary.imported).toBe(4);
    expect(summary.skipped).toBe(0);

    expect(targetStore.getAllSignals(USER)).toHaveLength(1);
    expect(targetStore.getEntities(USER, {})).toHaveLength(1);
    expect(targetStore.getTriples(USER, {})).toHaveLength(1);
    expect(targetStore.getEpisodes(USER, {})).toHaveLength(1);
  });

  it('importAll skips duplicates without erroring out', async () => {
    const store = new InMemoryBrainStore();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(64),
    });
    await port.recordSignal({
      id: 's1',
      source: 'g',
      type: 'e',
      timestamp: new Date(),
      data: {},
    });
    async function* gen(): AsyncIterable<MemoryRecord> {
      yield {
        kind: 'signal',
        payload: {
          id: 's1',
          source: 'g',
          type: 'e',
          timestamp: new Date(),
          data: {},
        },
      };
    }
    const summary = await port.importAll(gen());
    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});

describe('EmbeddedGbrainMemoryPort — summarize + compress', () => {
  it('summarize emits triple-derived text bounded by maxTokens', async () => {
    const store = new InMemoryBrainStore();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(64),
    });
    for (let i = 0; i < 10; i++) {
      await port.recordTriple({
        id: `t${i}`,
        userId: USER,
        subject: `entity${i}`,
        predicate: 'is',
        object: `value${i}`,
        validFrom: new Date(),
      });
    }
    const sum = await port.summarize({ scope: 'user-profile', maxTokens: 50 });
    expect(sum.tokenCount).toBeGreaterThan(0);
    expect(sum.tokenCount).toBeLessThanOrEqual(50);
    expect(sum.citations.length).toBeGreaterThan(0);
  });

  it('compress wraps summarize into a single CompressedView entry', async () => {
    const store = new InMemoryBrainStore();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(64),
    });
    const view = await port.compress(200);
    expect(view.entries).toHaveLength(1);
    expect(view.totalSourcesCompressed).toBeGreaterThanOrEqual(0);
  });
});

describe('EmbeddedGbrainMemoryPort — query embedding fallback', () => {
  it('falls back to text-only RRF when embedding throws', async () => {
    const failing = {
      model: 'fail',
      dim: 4,
      embed: async () => {
        throw new Error('boom');
      },
      embedBatch: async () => [],
    };
    const store = new InMemoryBrainStore();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: failing,
    });
    // Pre-populate via a non-failing path: insertPage directly with an embedding.
    store.insertPage({
      userId: USER,
      content: 'hello world',
      source: 'note',
      embedding: [0, 1, 0, 0],
      embeddingModel: 'static',
    });
    // searchSemantic should not throw even though the query embedding fails.
    const hits = await port.searchSemantic('hello', 5);
    // Text-only RRF still produces a hit.
    expect(hits.length).toBeGreaterThan(0);
  });
});
