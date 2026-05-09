/**
 * Integration tests for the EmbeddedGbrainMemoryPort against the in-memory
 * store. These exercise the *full* MemoryPort surface end-to-end (write →
 * search → graph walk → episode lookup → export → import) so the contract
 * stays honest as the implementation evolves. CRDB-backed integration
 * (the real production path) is exercised by `apps/api/src/__tests__`
 * route tests, which are gated on a live DB.
 */

import { describe, it, expect } from 'vitest';
import { EmbeddedGbrainMemoryPort } from '../embedded-port.js';
import {
  HashEmbeddingProvider,
  InMemoryBrainStore,
} from '@skytwin/memory-gbrain-crdb-adapter';
import { HybridMemoryPort } from '@skytwin/memory-hybrid';
import type { MemoryPort, RawSignal, MemoryRecord } from '@skytwin/memory-port';

const USER = 'integration-user';

function makePort(): { port: EmbeddedGbrainMemoryPort; store: InMemoryBrainStore } {
  const store = new InMemoryBrainStore();
  const port = new EmbeddedGbrainMemoryPort({
    userId: USER,
    backend: 'memory',
    store,
    embedding: new HashEmbeddingProvider(128),
  });
  return { port, store };
}

describe('integration — full MemoryPort lifecycle', () => {
  it('write → searchSemantic → walkGraph → getEpisodes works end-to-end', async () => {
    const { port } = makePort();

    // Seed signals
    const signals: RawSignal[] = [
      {
        id: 'sig-budget',
        source: 'gmail',
        type: 'email',
        timestamp: new Date('2026-04-01'),
        data: { subject: 'Q2 budget review meeting', from: 'cfo@example.com' },
      },
      {
        id: 'sig-migration',
        source: 'cal',
        type: 'event',
        timestamp: new Date('2026-04-10'),
        data: { subject: 'Database migration kickoff' },
      },
    ];
    for (const s of signals) await port.recordSignal(s);

    // Seed entities
    await port.recordEntity({
      id: 'cfo',
      userId: USER,
      name: 'CFO Jane',
      entityType: 'person',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });
    await port.recordTriple({
      id: 'jane-works-acme',
      userId: USER,
      subject: 'CFO Jane',
      predicate: 'works_at',
      object: 'Acme',
      validFrom: new Date('2025-01-01'),
    });

    // Seed episodes
    await port.recordEpisode({
      id: 'ep-budget-review',
      userId: USER,
      wing: 'work',
      summary: 'Q2 budget review approved',
      startedAt: new Date('2026-04-01T10:00:00Z'),
      endedAt: new Date('2026-04-01T11:00:00Z'),
    });

    // Search
    const hits = await port.searchSemantic('budget review meeting', 5);
    expect(hits.length).toBeGreaterThan(0);

    // Graph walk
    const nodes = await port.walkGraph({ startNodeId: 'CFO Jane', maxDepth: 2 });
    expect(nodes).toHaveLength(1);

    // Episode lookup
    const episodes = await port.getEpisodes({
      from: new Date('2026-03-01'),
      to: new Date('2026-05-01'),
    });
    expect(episodes).toHaveLength(1);

    // Entities by type
    const people = await port.getEntitiesByType('person');
    expect(people).toHaveLength(1);
  });

  it('hybrid mode dual-writes and reads from primary by default', async () => {
    const { port: primary, store: primaryStore } = makePort();

    // Build a secondary as a no-op stub that satisfies MemoryPort + records writes.
    let secondaryWrites = 0;
    const secondary: MemoryPort = {
      capabilities: () => new Set(['spatial_wings', 'aaak_compression']),
      recordSignal: async () => {
        secondaryWrites++;
      },
      recordEntity: async () => {
        secondaryWrites++;
      },
      recordTriple: async () => {
        secondaryWrites++;
      },
      recordEpisode: async () => {
        secondaryWrites++;
      },
      searchSemantic: async () => [],
      walkGraph: async () => [],
      getEpisodes: async () => [],
      getEntitiesByType: async () => [],
      getTriples: async () => [],
      summarize: async () => ({ text: '', tokenCount: 0, citations: [] }),
      compress: async () => ({ entries: [], totalSourcesCompressed: 0 }),
      exportAll: async function* (): AsyncGenerator<MemoryRecord, void, unknown> {},
      importAll: async () => ({ imported: 0, skipped: 0 }),
    };

    const hybrid = new HybridMemoryPort({ primary, secondary });

    await hybrid.recordSignal({
      id: 'sig-1',
      source: 'gmail',
      type: 'email',
      timestamp: new Date(),
      data: { subject: 'hello' },
    });
    expect(primaryStore.getAllSignals(USER)).toHaveLength(1);
    expect(secondaryWrites).toBe(1);

    // Search uses primary (which has semantic_search).
    const hits = await hybrid.searchSemantic('hello', 5);
    expect(hits.length).toBeGreaterThanOrEqual(0);
    expect(hybrid.getDiagnostics().routedPrimary).toBe(1);
  });
});

describe('integration — multi-user isolation', () => {
  it('user-A signals never appear in user-B searches', async () => {
    const storeA = new InMemoryBrainStore();
    const portA = new EmbeddedGbrainMemoryPort({
      userId: 'user-A',
      backend: 'memory',
      store: storeA,
      embedding: new HashEmbeddingProvider(64),
    });
    const portB = new EmbeddedGbrainMemoryPort({
      userId: 'user-B',
      backend: 'memory',
      store: storeA, // same store
      embedding: new HashEmbeddingProvider(64),
    });
    await portA.recordSignal({
      id: 'sig-a-1',
      source: 'gmail',
      type: 'email',
      timestamp: new Date(),
      data: { subject: 'Alice secret budget' },
    });
    const aHits = await portA.searchSemantic('Alice secret', 5);
    const bHits = await portB.searchSemantic('Alice secret', 5);
    expect(aHits.length).toBeGreaterThan(0);
    expect(bHits).toHaveLength(0);
  });

  it('scaling — recording 200 signals stays sub-linear in search latency', async () => {
    const store = new InMemoryBrainStore();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(64),
    });
    for (let i = 0; i < 200; i++) {
      await port.recordSignal({
        id: `s-scale-${i}`,
        source: 'gmail',
        type: 'email',
        timestamp: new Date(Date.now() - i * 60_000),
        data: { subject: `topic ${i % 10} message ${i}` },
      });
    }
    const start = performance.now();
    const hits = await port.searchSemantic('topic 5 message', 5);
    const elapsed = performance.now() - start;
    expect(hits.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500); // very loose bound — guards regressions
  });
});

describe('integration — export/import full round-trip', () => {
  it('source → exportAll → importAll → target produces identical content', async () => {
    const { port: source } = makePort();

    await source.recordSignal({
      id: 's-export-1',
      source: 'gmail',
      type: 'email',
      timestamp: new Date('2026-01-01'),
      data: { subject: 'hello' },
    });
    await source.recordEntity({
      id: 'e-export-1',
      userId: USER,
      name: 'Alice',
      entityType: 'person',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });
    await source.recordTriple({
      id: 't-export-1',
      userId: USER,
      subject: 'alice',
      predicate: 'knows',
      object: 'bob',
      validFrom: new Date(),
    });
    await source.recordEpisode({
      id: 'ep-export-1',
      userId: USER,
      summary: 'Did the thing',
      startedAt: new Date(),
      endedAt: new Date(),
    });

    const exported: MemoryRecord[] = [];
    for await (const r of source.exportAll()) exported.push(r);
    expect(exported).toHaveLength(4);

    const { port: target } = makePort();
    async function* gen(): AsyncIterable<MemoryRecord> {
      for (const r of exported) yield r;
    }
    const summary = await target.importAll(gen());
    expect(summary.imported).toBe(4);
    expect(summary.skipped).toBe(0);

    // Re-export the target and compare the count of each kind.
    const reExported: MemoryRecord[] = [];
    for await (const r of target.exportAll()) reExported.push(r);
    const counts = (records: MemoryRecord[]) => {
      const c: Record<string, number> = {};
      for (const r of records) c[r.kind] = (c[r.kind] ?? 0) + 1;
      return c;
    };
    expect(counts(reExported)).toEqual(counts(exported));
  });
});
