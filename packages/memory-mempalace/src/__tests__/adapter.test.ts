import { describe, it, expect, vi } from 'vitest';
import { MemPalaceMemoryPort } from '../adapter.js';
import type { MemPalaceRepos } from '../adapter.js';
import type { KnowledgeTriple, KnowledgeEntity, EpisodicMemory } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeRepos(): MemPalaceRepos {
  const entities: KnowledgeEntity[] = [];
  const triples: KnowledgeTriple[] = [];
  const episodes: EpisodicMemory[] = [];

  const knowledgeGraph = {
    upsertEntity: vi.fn(async (
      userId: string,
      name: string,
      entityType: string,
      properties: Record<string, unknown>,
      _aliases: string[],
    ): Promise<KnowledgeEntity> => {
      const entity: KnowledgeEntity = {
        id: `ent-${name}`,
        userId,
        name,
        entityType: entityType as KnowledgeEntity['entityType'],
        properties,
        aliases: [],
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };
      entities.push(entity);
      return entity;
    }),
    getEntities: vi.fn(async (_userId: string, _type?: string): Promise<KnowledgeEntity[]> => {
      return entities;
    }),
    findEntity: vi.fn(async (_userId: string, name: string): Promise<KnowledgeEntity | null> => {
      return entities.find((e) => e.name === name) ?? null;
    }),
    addTriple: vi.fn(async (
      userId: string,
      subject: string,
      predicate: string,
      object: string,
      validFrom: Date,
      confidence: ConfidenceLevel,
      _sourceDrawerId?: string,
    ): Promise<KnowledgeTriple> => {
      const triple: KnowledgeTriple = {
        id: `tri-${subject}-${predicate}-${object}`,
        userId,
        subject,
        predicate,
        object,
        validFrom,
        validTo: null,
        confidence,
        extractedAt: new Date(),
      };
      triples.push(triple);
      return triple;
    }),
    queryTriples: vi.fn(async (
      _userId: string,
      options?: { subject?: string; predicate?: string; object?: string; asOf?: Date; limit?: number },
    ): Promise<KnowledgeTriple[]> => {
      let result = triples;
      if (options?.subject) result = result.filter((t) => t.subject === options.subject);
      if (options?.predicate) result = result.filter((t) => t.predicate === options.predicate);
      if (options?.object) result = result.filter((t) => t.object === options.object);
      return result.slice(0, options?.limit ?? result.length);
    }),
    invalidateTriple: vi.fn(async () => undefined),
  };

  const episode = {
    createEpisode: vi.fn(async (input: {
      userId: string;
      situationSummary: string;
      domain: string;
      situationType: string;
      contextSnapshot: import('@skytwin/shared-types').EpisodeContext;
    }): Promise<EpisodicMemory> => {
      const ep: EpisodicMemory = {
        id: `ep-${episodes.length + 1}`,
        userId: input.userId,
        situationSummary: input.situationSummary,
        domain: input.domain,
        situationType: input.situationType,
        contextSnapshot: input.contextSnapshot,
        signalIds: [],
        drawerIds: [],
        utilityScore: 0.5,
        createdAt: new Date('2025-01-10'),
        updatedAt: new Date('2025-01-10'),
      };
      episodes.push(ep);
      return ep;
    }),
    getEpisodes: vi.fn(async (_userId: string, _opts?: unknown): Promise<EpisodicMemory[]> => episodes),
    getEpisodeByDecision: vi.fn(async () => null),
    updateEpisode: vi.fn(async () => null),
    searchEpisodes: vi.fn(async () => []),
  };

  const palace = {
    createWing: vi.fn(async () => ({ id: 'wing-1', userId: '', name: '', description: '', domains: [], drawerCount: 0, createdAt: new Date(), updatedAt: new Date() })),
    getWings: vi.fn(async () => []),
    getWingByName: vi.fn(async () => null),
    createRoom: vi.fn(async () => ({ id: 'room-1', wingId: '', name: '', description: '', halls: [] as never[], drawerCount: 0, createdAt: new Date(), updatedAt: new Date() })),
    getRooms: vi.fn(async () => []),
    getRoomByName: vi.fn(async () => null),
    getRoomsByTopic: vi.fn(async () => []),
    createDrawer: vi.fn(async () => ({ id: 'drawer-1', roomId: '', wingId: '', userId: '', hall: 'facts' as const, content: '', metadata: { importance: 0.5 }, sourceType: 'signal' as const, createdAt: new Date(), updatedAt: new Date() })),
    getDrawers: vi.fn(async () => []),
    searchDrawers: vi.fn(async () => []),
    findDrawerBySourceId: vi.fn(async () => null),
    deleteDrawer: vi.fn(async () => true),
    upsertTunnel: vi.fn(async () => ({ id: 'tunnel-1', userId: '', topic: '', connectedRoomIds: [], connectedWingIds: [], strength: 1, createdAt: new Date(), updatedAt: new Date() })),
    getTunnels: vi.fn(async () => []),
    getStatus: vi.fn(async () => ({ userId: '', wingCount: 0, roomCount: 0, drawerCount: 0, closetCount: 0, tunnelCount: 0, entityCount: 0, tripleCount: 0, episodeCount: 0 })),
  };

  const closet = {
    getClosets: vi.fn(async () => []),
    createCloset: vi.fn(async (input: { roomId: string; wingId: string; userId: string; compressedContent: string; sourceDrawerIds: string[]; tokenCount: number }) => ({
      id: 'closet-1',
      roomId: input.roomId,
      wingId: input.wingId,
      userId: input.userId,
      compressedContent: input.compressedContent,
      sourceDrawerIds: input.sourceDrawerIds,
      drawerCount: input.sourceDrawerIds.length,
      tokenCount: input.tokenCount,
      createdAt: new Date(),
    })),
  };

  const tripleSearch = {
    queryTriples: vi.fn(async (_userId: string, options?: { subject?: string; predicate?: string; asOf?: Date; limit?: number }): Promise<KnowledgeTriple[]> => {
      let result = triples;
      if (options?.subject) result = result.filter((t) => t.subject === options.subject);
      if (options?.predicate) result = result.filter((t) => t.predicate === options.predicate);
      return result.slice(0, options?.limit ?? result.length);
    }),
  };

  const entityCode = {
    getEntityCodes: vi.fn(async () => []),
    upsertEntityCode: vi.fn(async (_userId: string, code: string, fullName: string, _entityId?: string) => ({ code, fullName })),
  };

  const closetPersistence = {
    createCloset: vi.fn(async (input: { roomId: string; wingId: string; userId: string; compressedContent: string; sourceDrawerIds: string[]; tokenCount: number }) => ({
      id: 'closet-1',
      roomId: input.roomId,
      wingId: input.wingId,
      userId: input.userId,
      compressedContent: input.compressedContent,
      sourceDrawerIds: input.sourceDrawerIds,
      drawerCount: input.sourceDrawerIds.length,
      tokenCount: input.tokenCount,
      createdAt: new Date(),
    })),
  };

  return { knowledgeGraph, episode, palace, closet, tripleSearch, entityCode, closetPersistence };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MemPalaceMemoryPort.capabilities()', () => {
  it('declares all six expected capabilities', () => {
    const port = new MemPalaceMemoryPort(makeRepos());
    const caps = port.capabilities();

    expect(caps.has('episodic')).toBe(true);
    expect(caps.has('spatial_wings')).toBe(true);
    expect(caps.has('aaak_compression')).toBe(true);
    expect(caps.has('temporal_triples')).toBe(true);
    expect(caps.has('graph_walk')).toBe(true);
    expect(caps.has('semantic_search')).toBe(true);
    expect(caps.size).toBe(6);
  });
});

describe('MemPalaceMemoryPort.recordEntity()', () => {
  it('delegates to KnowledgeGraph.recordEntity with correct args', async () => {
    const repos = makeRepos();
    const port = new MemPalaceMemoryPort(repos);

    await port.recordEntity({
      id: 'ent-alice',
      userId: 'u1',
      name: 'Alice',
      entityType: 'person',
      attributes: { role: 'engineer' },
      firstSeenAt: new Date('2025-01-01'),
      lastSeenAt: new Date('2025-01-15'),
    });

    expect(repos.knowledgeGraph.upsertEntity).toHaveBeenCalledWith(
      'u1',
      'Alice',
      'person',
      { role: 'engineer' },
      [],
    );
  });

  it('maps service entityType to concept (shared-types does not have service)', async () => {
    const repos = makeRepos();
    const port = new MemPalaceMemoryPort(repos);

    await port.recordEntity({
      id: 'ent-s3',
      userId: 'u1',
      name: 'AWS S3',
      entityType: 'service',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    expect(repos.knowledgeGraph.upsertEntity).toHaveBeenCalledWith(
      'u1',
      'AWS S3',
      'concept',   // 'service' falls back to 'concept'
      {},
      [],
    );
  });
});

describe('MemPalaceMemoryPort.getTriples()', () => {
  it('returns triples matching the given subject', async () => {
    const repos = makeRepos();
    const port = new MemPalaceMemoryPort(repos);

    await port.recordTriple({
      id: 'tri-1',
      userId: 'u1',
      subject: 'Alice',
      predicate: 'works_at',
      object: 'Acme',
      validFrom: new Date('2025-01-01'),
    });

    await port.recordTriple({
      id: 'tri-2',
      userId: 'u1',
      subject: 'Bob',
      predicate: 'works_at',
      object: 'Globex',
      validFrom: new Date('2025-01-01'),
    });

    const results = await port.getTriples('Alice', undefined, undefined);

    expect(results).toHaveLength(1);
    expect(results[0]!.subject).toBe('Alice');
    expect(results[0]!.object).toBe('Acme');
  });
});

describe('MemPalaceMemoryPort — round-trip: recordTriple then getTriples', () => {
  it('triple written via recordTriple is returned by getTriples', async () => {
    const repos = makeRepos();
    const port = new MemPalaceMemoryPort(repos);

    await port.recordTriple({
      id: 'tri-rt',
      userId: 'u1',
      subject: 'Carol',
      predicate: 'knows',
      object: 'Dave',
      validFrom: new Date('2025-03-01'),
    });

    const all = await port.getTriples(undefined, undefined, undefined);
    expect(all.some((t) => t.subject === 'Carol' && t.object === 'Dave')).toBe(true);
  });
});
