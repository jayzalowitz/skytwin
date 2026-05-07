import { describe, it, expect, vi } from 'vitest';
import { exportAllStream, importAllStream } from '../migration.js';
import type { MemoryPort } from '../port.js';
import type {
  MemoryCapability,
  RawSignal,
  KnowledgeEntity,
  KnowledgeTriple,
  Episode,
  MemoryRecord,
} from '../types.js';

// ── Helper: build an in-memory port for migration testing ─────────────────────

function makeInMemoryPort(
  initialSignals: RawSignal[] = [],
  initialEntities: KnowledgeEntity[] = [],
  initialTriples: KnowledgeTriple[] = [],
  initialEpisodes: Episode[] = [],
): MemoryPort {
  const signals = [...initialSignals];
  const entities = [...initialEntities];
  const triples = [...initialTriples];
  const episodes = [...initialEpisodes];
  const seenIds = new Set<string>();

  function assertNoDuplicate(id: string): void {
    if (seenIds.has(id)) throw new Error(`duplicate id: ${id}`);
    seenIds.add(id);
  }

  return {
    capabilities: (): Set<MemoryCapability> => new Set(['semantic_search']),

    recordSignal: vi.fn(async (s: RawSignal) => {
      assertNoDuplicate(s.id);
      signals.push(s);
    }),
    recordEntity: vi.fn(async (e: KnowledgeEntity) => {
      assertNoDuplicate(e.id);
      entities.push(e);
    }),
    recordTriple: vi.fn(async (t: KnowledgeTriple) => {
      assertNoDuplicate(t.id);
      triples.push(t);
    }),
    recordEpisode: vi.fn(async (ep: Episode) => {
      assertNoDuplicate(ep.id);
      episodes.push(ep);
    }),

    searchSemantic: vi.fn(async () => []),
    walkGraph: vi.fn(async () => []),
    getEpisodes: vi.fn(async () => episodes),
    getEntitiesByType: vi.fn(async () => entities),
    getTriples: vi.fn(async () => triples),
    summarize: vi.fn(async () => ({ text: '', tokenCount: 0, citations: [] })),
    compress: vi.fn(async () => ({ entries: [], totalSourcesCompressed: 0 })),

    exportAll: async function* (): AsyncIterable<MemoryRecord> {
      for (const s of signals) yield { kind: 'signal', payload: s };
      for (const e of entities) yield { kind: 'entity', payload: e };
      for (const t of triples) yield { kind: 'triple', payload: t };
      for (const ep of episodes) yield { kind: 'episode', payload: ep };
    },

    importAll: vi.fn(async (_records: AsyncIterable<MemoryRecord>) => ({ imported: 0, skipped: 0 })),
  };
}

// ── Test data fixtures ─────────────────────────────────────────────────────────

const signal1: RawSignal = {
  id: 'sig-1',
  source: 'gmail',
  type: 'email',
  timestamp: new Date('2025-01-01T10:00:00Z'),
  data: { subject: 'Hello' },
};

const signal2: RawSignal = {
  id: 'sig-2',
  source: 'calendar',
  type: 'event',
  timestamp: new Date('2025-01-02T10:00:00Z'),
  data: { title: 'Meeting' },
};

const entity1: KnowledgeEntity = {
  id: 'ent-1',
  userId: 'u1',
  name: 'Alice',
  entityType: 'person',
  firstSeenAt: new Date('2025-01-01'),
  lastSeenAt: new Date('2025-01-15'),
};

const triple1: KnowledgeTriple = {
  id: 'tri-1',
  userId: 'u1',
  subject: 'Alice',
  predicate: 'works_at',
  object: 'Acme',
  validFrom: new Date('2025-01-01'),
};

const episode1: Episode = {
  id: 'ep-1',
  userId: 'u1',
  summary: 'Sent email to Alice',
  startedAt: new Date('2025-01-10T09:00:00Z'),
  endedAt: new Date('2025-01-10T09:05:00Z'),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('exportAllStream + importAllStream — round-trip', () => {
  it('round-trips all record kinds: signals, entities, triples, episodes', async () => {
    const portA = makeInMemoryPort([signal1, signal2], [entity1], [triple1], [episode1]);
    const portB = makeInMemoryPort();

    const stream = exportAllStream(portA);
    const { imported, skipped } = await importAllStream(portB, stream);

    expect(imported).toBe(5); // 2 signals + 1 entity + 1 triple + 1 episode = 5
    expect(skipped).toBe(0);

    expect(portB.recordSignal).toHaveBeenCalledTimes(2);
    expect(portB.recordEntity).toHaveBeenCalledWith(entity1);
    expect(portB.recordTriple).toHaveBeenCalledWith(triple1);
    expect(portB.recordEpisode).toHaveBeenCalledWith(episode1);
  });

  it('exportAllStream yields signals before entities before triples before episodes', async () => {
    const portA = makeInMemoryPort([signal1], [entity1], [triple1], [episode1]);
    const kinds: string[] = [];

    for await (const record of exportAllStream(portA)) {
      kinds.push(record.kind);
    }

    const signalIdx = kinds.indexOf('signal');
    const entityIdx = kinds.indexOf('entity');
    const tripleIdx = kinds.indexOf('triple');
    const episodeIdx = kinds.indexOf('episode');

    expect(signalIdx).toBeLessThan(entityIdx);
    expect(entityIdx).toBeLessThan(tripleIdx);
    expect(tripleIdx).toBeLessThan(episodeIdx);
  });

  it('importAllStream is idempotent: re-importing skips duplicates', async () => {
    const portA = makeInMemoryPort([signal1], [entity1], [triple1], [episode1]);

    // Collect the stream into an array so we can replay it twice
    const records: MemoryRecord[] = [];
    for await (const r of exportAllStream(portA)) {
      records.push(r);
    }

    async function* replayStream(): AsyncIterable<MemoryRecord> {
      yield* records;
    }

    const portB = makeInMemoryPort();

    const first = await importAllStream(portB, replayStream());
    expect(first.imported).toBe(4);
    expect(first.skipped).toBe(0);

    // Second import must skip all — portB already saw those IDs
    const second = await importAllStream(portB, replayStream());
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(4);
  });
});
