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
 * Counters surfaced for observability — a hybrid backend that silently
 * loses secondary writes is hard to debug, so we keep counts the caller
 * can inspect (and the API exposes via `/api/memory-config/diagnostics`).
 */
export interface HybridDiagnostics {
  routedPrimary: number;
  routedSecondary: number;
  writesPrimaryOk: number;
  writesSecondaryOk: number;
  writesSecondaryFailed: number;
  writesPrimaryFailed: number;
}

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
  getEntitiesByType?: 'primary' | 'secondary';
  summarize?: 'primary' | 'secondary';
  compress?: 'primary' | 'secondary';
}

const DEFAULT_ROUTING: Required<RoutingRules> = {
  searchSemantic: 'primary',
  code_aware_search: 'primary',
  walkGraph: 'secondary',
  getEpisodes: 'secondary',
  getTriples: 'secondary',
  // Embedded gbrain backend supports entity reads natively; default to
  // primary so we don't lose entities the gbrain side has indexed.
  // Fallback to secondary still kicks in via resolveReadPort when primary
  // lacks the capability.
  getEntitiesByType: 'primary',
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
  private readonly diagnostics: HybridDiagnostics = {
    routedPrimary: 0,
    routedSecondary: 0,
    writesPrimaryOk: 0,
    writesSecondaryOk: 0,
    writesSecondaryFailed: 0,
    writesPrimaryFailed: 0,
  };

  constructor({ primary, secondary, routing }: HybridMemoryPortOptions) {
    this.primary = primary;
    this.secondary = secondary;
    this.routing = { ...DEFAULT_ROUTING, ...routing };
  }

  /**
   * Snapshot of routing + write outcome counters. Reset by `resetDiagnostics`.
   * Uses a defensive copy so the caller can't mutate the underlying counters.
   */
  getDiagnostics(): HybridDiagnostics {
    return { ...this.diagnostics };
  }

  resetDiagnostics(): void {
    this.diagnostics.routedPrimary = 0;
    this.diagnostics.routedSecondary = 0;
    this.diagnostics.writesPrimaryOk = 0;
    this.diagnostics.writesSecondaryOk = 0;
    this.diagnostics.writesSecondaryFailed = 0;
    this.diagnostics.writesPrimaryFailed = 0;
  }

  capabilities(): Set<MemoryCapability> {
    const combined = new Set<MemoryCapability>();
    for (const cap of this.primary.capabilities()) combined.add(cap);
    for (const cap of this.secondary.capabilities()) combined.add(cap);
    return combined;
  }

  // ── Write — best-effort dual-write ───────────────────────────────

  async recordSignal(s: RawSignal): Promise<void> {
    await this.primaryWrite('recordSignal', () => this.primary.recordSignal(s));
    await this.bestEffortSecondary('recordSignal', () => this.secondary.recordSignal(s));
  }

  async recordEntity(e: KnowledgeEntity): Promise<void> {
    await this.primaryWrite('recordEntity', () => this.primary.recordEntity(e));
    await this.bestEffortSecondary('recordEntity', () => this.secondary.recordEntity(e));
  }

  async recordTriple(t: KnowledgeTriple): Promise<void> {
    await this.primaryWrite('recordTriple', () => this.primary.recordTriple(t));
    await this.bestEffortSecondary('recordTriple', () => this.secondary.recordTriple(t));
  }

  async recordEpisode(e: Episode): Promise<void> {
    await this.primaryWrite('recordEpisode', () => this.primary.recordEpisode(e));
    await this.bestEffortSecondary('recordEpisode', () => this.secondary.recordEpisode(e));
  }

  private async primaryWrite(op: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.diagnostics.writesPrimaryOk++;
    } catch (err) {
      this.diagnostics.writesPrimaryFailed++;
      log.warn(`primary write failed for ${op}; rethrowing`, {
        operation: op,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
      throw err;
    }
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
    // Route through resolveReadPort so the routing rule + capability check
    // are honoured. The embedded gbrain backend now supports entity reads;
    // previously this was hard-wired to the secondary, which sent entity
    // queries through the secondary even when the primary could serve them.
    // We fold in a `temporal_triples` capability check as a stand-in for
    // entity support — both gbrain and mempalace declare it iff they store
    // structured entity/triple state.
    const port = this.resolveReadPort('getEntitiesByType', 'temporal_triples');
    return port.getEntitiesByType(type, filter);
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
   * Priority (in order):
   *   1. Explicit routing override for the method name. If the override names
   *      the primary but the primary lacks the capability, fall through to
   *      the secondary anyway — never silently route to a port that can't
   *      serve the call.
   *   2. Default routing table preference.
   *   3. Final fallback: whichever port declares the capability.
   *
   * Diagnostics counters track every read so misrouting bugs surface in the
   * `/api/memory-config/diagnostics` snapshot.
   */
  private resolveReadPort(
    methodKey: keyof RoutingRules,
    capability: MemoryCapability,
  ): MemoryPort {
    const rule = this.routing[methodKey];
    const primaryHas = this.primary.capabilities().has(capability);
    const secondaryHas = this.secondary.capabilities().has(capability);

    let chosen: MemoryPort;
    if (rule === 'primary') {
      chosen = primaryHas ? this.primary : this.secondary;
    } else {
      chosen = secondaryHas ? this.secondary : this.primary;
    }

    if (chosen === this.primary) this.diagnostics.routedPrimary++;
    else this.diagnostics.routedSecondary++;
    return chosen;
  }

  /**
   * Run a secondary write in the background. Errors are logged and swallowed
   * so they never interfere with the primary write result. Counters move so
   * silent regressions are observable.
   */
  private async bestEffortSecondary(
    operation: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
      this.diagnostics.writesSecondaryOk++;
    } catch (err: unknown) {
      this.diagnostics.writesSecondaryFailed++;
      log.warn(`secondary write failed for ${operation}; ignoring`, {
        operation,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
}
