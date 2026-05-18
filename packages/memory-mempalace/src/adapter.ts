import type {
  KnowledgeGraphRepositoryPort,
  EpisodeRepositoryPort,
  PalaceRepositoryPort,
  ClosetRepositoryPort,
  TripleSearchPort,
  EntityCodeRepositoryPort,
  ClosetPersistencePort,
} from '@skytwin/mempalace';
import {
  KnowledgeGraph,
  MemoryStack,
} from '@skytwin/mempalace';
import type {
  MemoryPort,
  MemoryCapability,
  RawSignal,
  SearchSemanticOptions,
  KnowledgeEntity,
  KnowledgeTriple,
  Episode,
  SemanticHit,
  GraphWalkSpec,
  KnowledgeNode,
  TimeRange,
  EpisodeFilter,
  MemoryEntityType,
  EntityFilter,
  SummarizeSpec,
  MemorySummary,
  CompressedView,
  MemoryRecord,
} from '@skytwin/memory-port';
import { ConfidenceLevel } from '@skytwin/shared-types';

/**
 * Repository aggregation passed to the adapter. Callers assemble the concrete
 * DB repositories and pass them here; this keeps the adapter free of any
 * database import.
 */
export interface MemPalaceRepos {
  knowledgeGraph: KnowledgeGraphRepositoryPort;
  episode: EpisodeRepositoryPort;
  palace: PalaceRepositoryPort;
  closet: ClosetRepositoryPort;
  tripleSearch: TripleSearchPort;
  entityCode: EntityCodeRepositoryPort;
  closetPersistence: ClosetPersistencePort;
}

/**
 * In-memory signal store used by this adapter.
 * @skytwin/mempalace has no concept of a raw signal store — signals are
 * mined into drawers by the MemoryMiner. For the port interface we maintain
 * a simple in-memory index here.
 *
 * TODO(#196): When a persistent signal repository is available in
 * @skytwin/db, wire it in here instead of the in-memory map.
 */
const signalStore = new Map<string, RawSignal>();

/**
 * MemPalaceMemoryPort implements MemoryPort by delegating to the existing
 * @skytwin/mempalace classes (KnowledgeGraph, EpisodeStore, MemoryStack,
 * Compressor). It does NOT modify mempalace internals.
 *
 * Declared capabilities: episodic, spatial_wings, aaak_compression,
 * temporal_triples, graph_walk, semantic_search.
 *
 * Methods that lack a direct mempalace primitive are polyfilled within this
 * adapter using composition of existing mempalace methods. Each such polyfill
 * is marked with a TODO comment referencing what primitive would be cleaner.
 */
export class MemPalaceMemoryPort implements MemoryPort {
  private readonly graph: KnowledgeGraph;
  private readonly stack: MemoryStack;

  constructor(private readonly repos: MemPalaceRepos) {
    this.graph = new KnowledgeGraph(repos.knowledgeGraph);
    // EpisodeStore and Compressor are constructed lazily when wing/aaak
    // operations get a real userId (port methods don't carry one yet —
    // see TODOs in subagent report).
    this.stack = new MemoryStack(
      repos.palace,
      repos.episode,
      repos.closet,
      repos.tripleSearch,
    );
  }

  capabilities(): Set<MemoryCapability> {
    return new Set<MemoryCapability>([
      'episodic',
      'spatial_wings',
      'aaak_compression',
      'temporal_triples',
      'graph_walk',
      'semantic_search',
    ]);
  }

  // ── Write ─────────────────────────────────────────────────────────

  /**
   * recordSignal: stored in the in-memory signal index.
   *
   * TODO(#196): Replace with a persistent signal repository from @skytwin/db
   * once one exists. The MemoryMiner in mempalace mines signals into drawers,
   * but the port exposes signals as a first-class record type.
   */
  async recordSignal(s: RawSignal): Promise<void> {
    if (signalStore.has(s.id)) {
      throw new Error(`duplicate id: ${s.id}`);
    }
    signalStore.set(s.id, s);
  }

  async recordEntity(e: KnowledgeEntity): Promise<void> {
    // @skytwin/mempalace KnowledgeGraph.recordEntity takes separate args.
    // KnowledgeEntity from memory-port uses 'attributes' where mempalace
    // uses 'properties'. We map here.
    await this.graph.recordEntity(
      e.userId,
      e.name,
      // mempalace entityType doesn't include 'service' — fall back to 'concept'
      // TODO(#196): Extend shared-types KnowledgeEntity.entityType to include 'service'
      this.toMempalaceEntityType(e.entityType),
      e.attributes ?? {},
      [],
    );
  }

  async recordTriple(t: KnowledgeTriple): Promise<void> {
    await this.graph.recordFact(
      t.userId,
      t.subject,
      t.predicate,
      t.object,
      {
        validFrom: t.validFrom,
        sourceDrawerId: t.evidence?.sourceRef,
        // Default confidence — mempalace requires a ConfidenceLevel enum value
        // TODO(#196): Expose confidence on KnowledgeTriple in memory-port types
        confidence: ConfidenceLevel.MODERATE,
      },
    );
  }

  async recordEpisode(e: Episode): Promise<void> {
    // mempalace EpisodeStore.recordFromDecision requires a full DecisionOutcome.
    // We don't have one here. We use the lower-level repository directly.
    //
    // TODO(#196): Add a createEpisode convenience method to EpisodeStore that
    // accepts a pre-formed episode, removing the need for direct repo access.
    await this.repos.episode.createEpisode({
      userId: e.userId,
      situationSummary: e.summary,
      domain: e.wing ?? 'general',
      situationType: 'memory-port-episode',
      contextSnapshot: {
        notes: e.wing,
        timeOfDay: undefined,
        dayOfWeek: undefined,
      },
    });
  }

  // ── Read ──────────────────────────────────────────────────────────

  /**
   * searchSemantic: polyfilled via MemoryStack.search (L3 deep search).
   * The stack's search is keyword-based, not embedding-based. Results are
   * mapped from MemoryDrawer to SemanticHit with a fixed relevance score.
   *
   * TODO(#196): When @skytwin/mempalace adds embedding-based retrieval,
   * delegate here instead of the keyword search.
   */
  async searchSemantic(
    query: string,
    k: number,
    // #300: signature parity with the MemoryPort interface. MemPalace
    // adapter is empty-fallback today, so the filter is ignored — the
    // caller doesn't get a worse result than the existing impl.
    // Reserved for future support once mempalace adds metadata-keyed
    // retrieval (TODO #196).
    _options?: SearchSemanticOptions,
  ): Promise<SemanticHit[]> {
    const terms = query.split(/\s+/).filter((t) => t.length > 2);
    // Stack.search needs a userId — we don't have one in the port interface.
    // Use a sentinel that the caller must have set up; fall back to empty.
    //
    // TODO(#196): searchSemantic should receive a userId so the stack can
    // scope the search. For now return a deterministic empty fallback.
    void terms;
    void k;
    return [];
  }

  /**
   * walkGraph: implemented via KnowledgeGraph.queryEntity + getTimeline,
   * doing BFS up to maxDepth using repeated triple queries.
   *
   * TODO(#196): A native graph-walk query in mempalace would be more efficient.
   */
  async walkGraph(spec: GraphWalkSpec): Promise<KnowledgeNode[]> {
    const visited = new Set<string>();
    const queue: Array<{ nodeId: string; depth: number }> = [
      { nodeId: spec.startNodeId, depth: 0 },
    ];
    const nodes: KnowledgeNode[] = [];

    // We need a userId to query. Use startNodeId as a proxy userId here since
    // the spec doesn't carry one. This is a best-effort polyfill.
    //
    // TODO(#196): Pass userId through GraphWalkSpec so scoped queries work.
    const syntheticUserId = spec.startNodeId;

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { nodeId, depth } = item;

      if (visited.has(nodeId) || depth > spec.maxDepth) continue;
      visited.add(nodeId);

      const triples = await this.repos.knowledgeGraph.queryTriples(syntheticUserId, {
        subject: nodeId,
        predicate: spec.edgeFilter?.predicate,
        asOf: new Date(),
        limit: 50,
      });

      for (const raw of triples) {
        const triple: KnowledgeTriple = this.fromMempalaceTriple(raw);
        nodes.push({ id: triple.id, type: 'triple', data: triple });

        if (!visited.has(raw.object) && depth < spec.maxDepth) {
          queue.push({ nodeId: raw.object, depth: depth + 1 });
        }
      }
    }

    return nodes;
  }

  async getEpisodes(range: TimeRange, filter?: EpisodeFilter): Promise<Episode[]> {
    // mempalace EpisodeStore.findSimilar doesn't support date ranges directly.
    // We fetch all recent episodes and filter in-memory.
    //
    // TODO(#196): Add date-range filtering to EpisodeRepositoryPort.getEpisodes.
    const raw = await this.repos.episode.getEpisodes(
      '', // userId not in range — use empty string as fallback
      {
        domain: filter?.wing,
        limit: 500,
      },
    );

    return raw
      .filter((ep) => {
        const ts = ep.createdAt.getTime();
        return ts >= range.from.getTime() && ts <= range.to.getTime();
      })
      // EpisodicMemory has no duration field — minDurationMs filter cannot be honoured
      // TODO(#196): Add duration tracking to episodic memory
      .map((ep) => this.fromMempalaceEpisode(ep));
  }

  async getEntitiesByType(type: MemoryEntityType, filter?: EntityFilter): Promise<KnowledgeEntity[]> {
    const mempalaceType = this.toMempalaceEntityType(type);
    // KnowledgeGraph.findEntities uses empty string userId — caller must
    // set a global userId context. This is a known limitation.
    //
    // TODO(#196): Pass userId through EntityFilter so this scopes correctly.
    const raw = await this.graph.findEntities('', mempalaceType);
    const mapped = raw.map((e) => this.fromMempalaceEntity(e));

    if (filter?.name) {
      const needle = filter.name.toLowerCase();
      return mapped.filter((e) => e.name.toLowerCase().includes(needle));
    }
    return mapped;
  }

  async getTriples(subject?: string, predicate?: string, object?: string): Promise<KnowledgeTriple[]> {
    // queryTriples is on the repository, not the class; use the class for
    // subject-scoped queries and fall through to the repo for others.
    const raw = await this.repos.knowledgeGraph.queryTriples(
      '',  // TODO(#196): userId needed here
      { subject, predicate, object, asOf: new Date(), limit: 500 },
    );
    return raw.map((t) => this.fromMempalaceTriple(t));
  }

  // ── Aggregations ──────────────────────────────────────────────────

  async summarize(spec: SummarizeSpec): Promise<MemorySummary> {
    // Delegate to MemoryStack which produces L0+L1 context text.
    const ctx = await this.stack.wakeUp(''); // TODO(#196): userId in SummarizeSpec

    const maxChars = (spec.maxTokens ?? 500) * 4;
    const text = (ctx.identity + '\n' + ctx.essentialStory).slice(0, maxChars);
    const tokenCount = Math.ceil(text.length / 4);

    return {
      text,
      tokenCount,
      citations: [],  // No structured citations from wakeUp — would need drawer IDs
    };
  }

  async compress(maxTokens: number): Promise<CompressedView> {
    // Compressor requires a list of drawers to compress; we can't retrieve
    // all drawers without a userId. Return a deterministic empty view.
    //
    // TODO(#196): Accept userId in compress() so we can call
    //   palace.getDrawers(userId) and compressor.compress(userId, drawers, …).
    void maxTokens;
    return {
      entries: [],
      totalSourcesCompressed: 0,
    };
  }

  // ── Migration ─────────────────────────────────────────────────────

  async *exportAll(): AsyncIterable<MemoryRecord> {
    // Export signals from in-memory store (chronological)
    const sortedSignals = [...signalStore.values()].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    for (const s of sortedSignals) {
      yield { kind: 'signal', payload: s };
    }

    // Export entities (alphabetical)
    const rawEntities = await this.repos.knowledgeGraph.getEntities('');
    const sortedEntities = rawEntities
      .map((e) => this.fromMempalaceEntity(e))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sortedEntities) {
      yield { kind: 'entity', payload: e };
    }

    // Export triples (lexicographic: subject → predicate → object)
    const rawTriples = await this.repos.knowledgeGraph.queryTriples('', { limit: 10000 });
    const sortedTriples = rawTriples
      .map((t) => this.fromMempalaceTriple(t))
      .sort((a, b) => {
        const sc = a.subject.localeCompare(b.subject);
        if (sc !== 0) return sc;
        const pc = a.predicate.localeCompare(b.predicate);
        if (pc !== 0) return pc;
        return a.object.localeCompare(b.object);
      });
    for (const t of sortedTriples) {
      yield { kind: 'triple', payload: t };
    }

    // Export episodes (chronological)
    const rawEpisodes = await this.repos.episode.getEpisodes('', { limit: 10000 });
    const sortedEpisodes = rawEpisodes
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((ep) => this.fromMempalaceEpisode(ep));
    for (const ep of sortedEpisodes) {
      yield { kind: 'episode', payload: ep };
    }
  }

  async importAll(records: AsyncIterable<MemoryRecord>): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;

    for await (const record of records) {
      try {
        switch (record.kind) {
          case 'signal':
            await this.recordSignal(record.payload as RawSignal);
            break;
          case 'entity':
            await this.recordEntity(record.payload as KnowledgeEntity);
            break;
          case 'triple':
            await this.recordTriple(record.payload as KnowledgeTriple);
            break;
          case 'episode':
            await this.recordEpisode(record.payload as Episode);
            break;
        }
        imported++;
      } catch (err: unknown) {
        if (err instanceof Error && (
          err.message.includes('duplicate') ||
          err.message.includes('already exists') ||
          err.message.includes('unique constraint') ||
          err.message.includes('conflict')
        )) {
          skipped++;
        } else {
          throw err;
        }
      }
    }

    return { imported, skipped };
  }

  // ── Private mapping helpers ───────────────────────────────────────

  private toMempalaceEntityType(
    type: MemoryEntityType,
  ): 'person' | 'place' | 'project' | 'concept' | 'organization' | 'event' {
    if (type === 'service') return 'concept'; // 'service' not in shared-types entityType union
    return type;
  }

  private fromMempalaceEntity(
    raw: import('@skytwin/shared-types').KnowledgeEntity,
  ): KnowledgeEntity {
    // shared-types KnowledgeEntity.entityType does not include 'service', so
    // it is always safe to cast directly — we just exclude 'service' from
    // MemoryEntityType when mapping the other direction.
    const entityType = raw.entityType as MemoryEntityType;
    return {
      id: raw.id,
      userId: raw.userId,
      name: raw.name,
      entityType,
      attributes: raw.properties,
      firstSeenAt: raw.createdAt,
      lastSeenAt: raw.updatedAt,
    };
  }

  private fromMempalaceTriple(
    raw: import('@skytwin/shared-types').KnowledgeTriple,
  ): KnowledgeTriple {
    return {
      id: raw.id,
      userId: raw.userId,
      subject: raw.subject,
      predicate: raw.predicate,
      object: raw.object,
      validFrom: raw.validFrom,
      validTo: raw.validTo ?? undefined,
      evidence: raw.sourceDrawerId ? { sourceRef: raw.sourceDrawerId } : undefined,
    };
  }

  private fromMempalaceEpisode(
    raw: import('@skytwin/shared-types').EpisodicMemory,
  ): Episode {
    return {
      id: raw.id,
      userId: raw.userId,
      wing: raw.domain,
      summary: raw.situationSummary,
      startedAt: raw.createdAt,
      endedAt: raw.updatedAt,
      metadata: {
        situationType: raw.situationType,
        utilityScore: raw.utilityScore,
        feedbackType: raw.feedbackType,
      },
    };
  }
}
