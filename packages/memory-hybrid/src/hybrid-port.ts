import type {
  MemoryPort,
  MemoryCapability,
  RawSignal,
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
import { createLogger } from '@skytwin/core';

const log = createLogger('memory-hybrid');

/**
 * Per-method routing overrides. Each key is a MemoryPort method name. A value
 * of 'primary' routes to the primary port; 'secondary' routes to the
 * secondary port. Missing keys fall back to the defaults.
 */
export interface RoutingRules {
  searchSemantic?: 'primary' | 'secondary';
  code_aware_search?: 'primary' | 'secondary';
  walkGraph?: 'primary' | 'secondary';
  getEpisodes?: 'primary' | 'secondary';
  getTriples?: 'primary' | 'secondary';
  summarize?: 'primary' | 'secondary';
  compress?: 'primary' | 'secondary';
}

const DEFAULT_ROUTING: Required<RoutingRules> = {
  searchSemantic: 'primary',
  code_aware_search: 'primary',
  walkGraph: 'secondary',
  getEpisodes: 'secondary',
  getTriples: 'secondary',
  summarize: 'secondary',
  compress: 'secondary',
};

export interface HybridMemoryPortOptions {
  primary: MemoryPort;
  secondary: MemoryPort;
  routing?: RoutingRules;
}

/**
 * HybridMemoryPort composes two MemoryPort implementations.
 *
 * READ routing:
 *   For each read operation the effective routing is determined by:
 *   1. An explicit override in `routing` options, OR
 *   2. Whether the primary port declares the relevant capability, OR
 *   3. The DEFAULT_ROUTING table (primary for semantic/code-aware, secondary
 *      for graph/episodic/triple/summarize/compress).
 *
 * WRITE routing:
 *   Writes go to BOTH backends. The primary write is awaited and its result is
 *   returned. The secondary write is best-effort: failures are logged but
 *   never bubble up. A primary write failure propagates normally.
 *
 * Migration:
 *   exportAll and importAll are routed to the secondary (MemPalace) only,
 *   since GbrainMemoryPort does not implement them.
 */
export class HybridMemoryPort implements MemoryPort {
  private readonly primary: MemoryPort;
  private readonly secondary: MemoryPort;
  private readonly routing: Required<RoutingRules>;

  constructor({ primary, secondary, routing }: HybridMemoryPortOptions) {
    this.primary = primary;
    this.secondary = secondary;
    this.routing = { ...DEFAULT_ROUTING, ...routing };
  }

  capabilities(): Set<MemoryCapability> {
    const combined = new Set<MemoryCapability>();
    for (const cap of this.primary.capabilities()) combined.add(cap);
    for (const cap of this.secondary.capabilities()) combined.add(cap);
    return combined;
  }

  // ── Write — best-effort dual-write ───────────────────────────────

  async recordSignal(s: RawSignal): Promise<void> {
    await this.primary.recordSignal(s);
    await this.bestEffortSecondary('recordSignal', () => this.secondary.recordSignal(s));
  }

  async recordEntity(e: KnowledgeEntity): Promise<void> {
    await this.primary.recordEntity(e);
    await this.bestEffortSecondary('recordEntity', () => this.secondary.recordEntity(e));
  }

  async recordTriple(t: KnowledgeTriple): Promise<void> {
    await this.primary.recordTriple(t);
    await this.bestEffortSecondary('recordTriple', () => this.secondary.recordTriple(t));
  }

  async recordEpisode(e: Episode): Promise<void> {
    await this.primary.recordEpisode(e);
    await this.bestEffortSecondary('recordEpisode', () => this.secondary.recordEpisode(e));
  }

  // ── Read — route by capability ────────────────────────────────────

  async searchSemantic(query: string, k: number): Promise<SemanticHit[]> {
    const port = this.resolveReadPort('searchSemantic', 'semantic_search');
    return port.searchSemantic(query, k);
  }

  async walkGraph(spec: GraphWalkSpec): Promise<KnowledgeNode[]> {
    const port = this.resolveReadPort('walkGraph', 'graph_walk');
    return port.walkGraph(spec);
  }

  async getEpisodes(range: TimeRange, filter?: EpisodeFilter): Promise<Episode[]> {
    const port = this.resolveReadPort('getEpisodes', 'episodic');
    return port.getEpisodes(range, filter);
  }

  async getEntitiesByType(
    type: MemoryEntityType,
    filter?: EntityFilter,
  ): Promise<KnowledgeEntity[]> {
    // Always route to secondary; primary (gbrain) does not implement this.
    return this.secondary.getEntitiesByType(type, filter);
  }

  async getTriples(
    subject?: string,
    predicate?: string,
    object?: string,
  ): Promise<KnowledgeTriple[]> {
    const port = this.resolveReadPort('getTriples', 'temporal_triples');
    return port.getTriples(subject, predicate, object);
  }

  // ── Aggregations ──────────────────────────────────────────────────

  async summarize(spec: SummarizeSpec): Promise<MemorySummary> {
    const port = this.resolveReadPort('summarize', 'aaak_compression');
    return port.summarize(spec);
  }

  async compress(maxTokens: number): Promise<CompressedView> {
    const port = this.resolveReadPort('compress', 'aaak_compression');
    return port.compress(maxTokens);
  }

  // ── Migration — route to secondary ───────────────────────────────

  async *exportAll(): AsyncIterable<MemoryRecord> {
    yield* this.secondary.exportAll();
  }

  async importAll(
    records: AsyncIterable<MemoryRecord>,
  ): Promise<{ imported: number; skipped: number }> {
    return this.secondary.importAll(records);
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * Resolve which port to use for a read operation.
   *
   * Priority:
   *   1. Explicit routing override for the method name.
   *   2. Default routing table.
   *
   * The capability check is used only as a tie-breaker fallback for unrecognised
   * methods; the default routing table covers all known methods.
   */
  private resolveReadPort(
    methodKey: keyof RoutingRules,
    capability: MemoryCapability,
  ): MemoryPort {
    const rule = this.routing[methodKey];
    if (rule === 'primary') {
      return this.primary.capabilities().has(capability) ? this.primary : this.secondary;
    }
    return this.secondary;
  }

  /**
   * Run a secondary write in the background. Errors are logged and swallowed
   * so they never interfere with the primary write result.
   */
  private async bestEffortSecondary(
    operation: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
    } catch (err: unknown) {
      log.warn(`secondary write failed for ${operation}; ignoring`, {
        operation,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
}
