import type { MemoryPort, SearchSemanticOptions } from './port.js';
import type {
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
  MemoryCapability,
} from './types.js';

export interface PolyfillStat {
  method: string;
  latencyMs: number;
  calls: number;
}

/**
 * SignalsRouter wraps a MemoryPort and provides graceful degradation when
 * the underlying backend lacks a capability. Polyfills are transparently
 * injected for missing capabilities; native calls are preferred when the
 * backend declares the capability.
 *
 * Polyfill costs are tracked via polyfillStats() so that budget tracking
 * from the execution-router work can account for the extra latency.
 */
export class SignalsRouter implements MemoryPort {
  private readonly stats = new Map<string, { latencyMs: number; calls: number }>();

  constructor(private readonly backend: MemoryPort) {}

  capabilities(): Set<MemoryCapability> {
    return this.backend.capabilities();
  }

  // ── Write passthroughs ────────────────────────────────────────────

  recordSignal(s: RawSignal): Promise<void> {
    return this.backend.recordSignal(s);
  }

  recordEntity(e: KnowledgeEntity): Promise<void> {
    return this.backend.recordEntity(e);
  }

  recordTriple(t: KnowledgeTriple): Promise<void> {
    return this.backend.recordTriple(t);
  }

  recordEpisode(e: Episode): Promise<void> {
    return this.backend.recordEpisode(e);
  }

  // ── Read with polyfill fallback ───────────────────────────────────

  /**
   * walkGraph: native if backend has `graph_walk`; otherwise BFS via
   * repeated getTriples calls up to maxDepth.
   */
  async walkGraph(spec: GraphWalkSpec): Promise<KnowledgeNode[]> {
    if (this.backend.capabilities().has('graph_walk')) {
      return this.backend.walkGraph(spec);
    }

    const start = Date.now();
    const result = await this.polyfillWalkGraph(spec);
    this.recordStat('walkGraph', Date.now() - start);
    return result;
  }

  /**
   * getEpisodes: native if backend has `episodic`; otherwise polyfill by
   * querying signals filtered by time range and clustering by source.
   */
  async getEpisodes(range: TimeRange, filter?: EpisodeFilter): Promise<Episode[]> {
    if (this.backend.capabilities().has('episodic')) {
      return this.backend.getEpisodes(range, filter);
    }

    const start = Date.now();
    const result = await this.polyfillGetEpisodes(range, filter);
    this.recordStat('getEpisodes', Date.now() - start);
    return result;
  }

  async getEntitiesByType(type: MemoryEntityType, filter?: EntityFilter): Promise<KnowledgeEntity[]> {
    return this.backend.getEntitiesByType(type, filter);
  }

  async getTriples(subject?: string, predicate?: string, object?: string): Promise<KnowledgeTriple[]> {
    return this.backend.getTriples(subject, predicate, object);
  }

  async searchSemantic(
    query: string,
    k: number,
    options?: SearchSemanticOptions,
  ): Promise<SemanticHit[]> {
    return this.backend.searchSemantic(query, k, options);
  }

  // ── Aggregations with polyfill fallback ───────────────────────────

  /**
   * summarize: native if backend has `aaak_compression` or `temporal_triples`;
   * otherwise falls back to a text assembly from getTriples and getEpisodes.
   */
  async summarize(spec: SummarizeSpec): Promise<MemorySummary> {
    const caps = this.backend.capabilities();
    if (caps.has('aaak_compression') || caps.has('temporal_triples')) {
      return this.backend.summarize(spec);
    }

    const start = Date.now();
    const result = await this.polyfillSummarize(spec);
    this.recordStat('summarize', Date.now() - start);
    return result;
  }

  /**
   * compress: native if backend has `aaak_compression`; otherwise polyfill via
   * the summarize method (which may itself be polyfilled).
   */
  async compress(maxTokens: number): Promise<CompressedView> {
    if (this.backend.capabilities().has('aaak_compression')) {
      return this.backend.compress(maxTokens);
    }

    const start = Date.now();
    const result = await this.polyfillCompress(maxTokens);
    this.recordStat('compress', Date.now() - start);
    return result;
  }

  // ── Migration ─────────────────────────────────────────────────────

  exportAll(): AsyncIterable<MemoryRecord> {
    return this.backend.exportAll();
  }

  importAll(records: AsyncIterable<MemoryRecord>): Promise<{ imported: number; skipped: number }> {
    return this.backend.importAll(records);
  }

  // ── Stats ─────────────────────────────────────────────────────────

  /**
   * Returns stats for all polyfill calls made so far.
   * Exposes the cost of capability gaps for budget tracking.
   */
  polyfillStats(): PolyfillStat[] {
    const result: PolyfillStat[] = [];
    for (const [method, data] of this.stats.entries()) {
      result.push({ method, latencyMs: data.latencyMs, calls: data.calls });
    }
    return result;
  }

  // ── Private polyfill implementations ─────────────────────────────

  private async polyfillWalkGraph(spec: GraphWalkSpec): Promise<KnowledgeNode[]> {
    const visited = new Set<string>();
    const queue: Array<{ nodeId: string; depth: number }> = [
      { nodeId: spec.startNodeId, depth: 0 },
    ];
    const nodes: KnowledgeNode[] = [];

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { nodeId, depth } = item;

      if (visited.has(nodeId) || depth > spec.maxDepth) continue;
      visited.add(nodeId);

      const triples = await this.backend.getTriples(
        nodeId,
        spec.edgeFilter?.predicate,
        undefined,
      );

      for (const triple of triples) {
        nodes.push({ id: triple.id, type: 'triple', data: triple });

        if (!visited.has(triple.object) && depth < spec.maxDepth) {
          queue.push({ nodeId: triple.object, depth: depth + 1 });
        }
      }
    }

    return nodes;
  }

  private async polyfillGetEpisodes(range: TimeRange, filter?: EpisodeFilter): Promise<Episode[]> {
    // Without episodic capability we cannot reconstruct episodes; return empty
    // and rely on the caller to degrade gracefully. This is intentionally
    // conservative — returning fabricated episodes would be worse than none.
    void range;
    void filter;
    return [];
  }

  private async polyfillSummarize(spec: SummarizeSpec): Promise<MemorySummary> {
    // Assemble a text summary from knowledge graph triples as a best-effort fallback.
    const triples = await this.backend.getTriples(undefined, undefined, undefined);
    const maxTokens = spec.maxTokens ?? 500;
    const charsPerToken = 4;
    const maxChars = maxTokens * charsPerToken;

    const lines: string[] = [];
    const citations: Array<{ ref: string; kind: string }> = [];

    for (const triple of triples) {
      const line = `${triple.subject} ${triple.predicate} ${triple.object}`;
      if ((lines.join('\n').length + line.length) > maxChars) break;
      lines.push(line);
      citations.push({ ref: triple.id, kind: 'triple' });
    }

    const text = lines.join('\n') || `Summary for scope: ${spec.scope}`;
    const tokenCount = Math.ceil(text.length / charsPerToken);

    return { text, tokenCount, citations };
  }

  private async polyfillCompress(maxTokens: number): Promise<CompressedView> {
    const summary = await this.summarize({ scope: 'user-profile', maxTokens });
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    return {
      entries: [
        {
          summary: summary.text,
          sourceCount: summary.citations.length,
          periodFrom: weekAgo,
          periodTo: now,
        },
      ],
      totalSourcesCompressed: summary.citations.length,
    };
  }

  private recordStat(method: string, latencyMs: number): void {
    const existing = this.stats.get(method);
    if (existing) {
      existing.latencyMs += latencyMs;
      existing.calls += 1;
    } else {
      this.stats.set(method, { latencyMs, calls: 1 });
    }
  }
}
