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
  EpisodeFilter,
  MemoryEntityType,
  EntityFilter,
  SummarizeSpec,
  MemorySummary,
  CompressedView,
  MemoryRecord,
} from './types.js';

/**
 * Optional metadata filter passed to `MemoryPort.searchSemantic` (#300).
 *
 * Implementations SHOULD push the filter into their backend's native
 * predicates (SQL `WHERE metadata->>'authoringTier' = ANY(...)` in the
 * CRDB adapter; equivalent filter in the in-memory store) rather than
 * doing client-side narrowing — pushdown lets the caller request `k`
 * results and get `k` matching results, instead of `k * over_fetch`
 * candidates that get narrowed in JS.
 *
 * Adapters that cannot push the filter SHOULD polyfill it: fetch a
 * generous candidate pool, filter, and slice to k. Document the
 * polyfill in the impl's docstring so callers know retrieval may be
 * less efficient than the native-pushdown path.
 *
 * The shape is extensible: future filters (e.g. by signal source,
 * date range) can land here without another interface change.
 */
export interface SearchSemanticOptions {
  /**
   * Restrict hits to `brain_pages.metadata.authoringTier` values that
   * appear in this list. Empty array or absent → no filter.
   *
   * Authoring-tier vocabulary (#251 Layer 1): `user_sent_originated`,
   * `user_sent_reply`, `inbox_personal`, `inbox_broadcast`,
   * `inbox_newsletter`, `inbox_automated`. Email-shaped today; the
   * vocabulary will expand as other connectors stamp the field.
   */
  authoringTier?: string[];
}

export interface MemoryPort {
  // Write
  recordSignal(s: RawSignal): Promise<void>;
  recordEntity(e: KnowledgeEntity): Promise<void>;
  recordTriple(t: KnowledgeTriple): Promise<void>;
  recordEpisode(e: Episode): Promise<void>;
  // Read
  /**
   * @param options — when set, the backend filters hits by the
   *   provided metadata predicates BEFORE applying the RRF fold +
   *   top-k cut. CRDB-backed adapters push the filter into SQL;
   *   other adapters may polyfill (see SearchSemanticOptions).
   *   Backward compatible: callers that pass only (query, k) get
   *   identical behavior to pre-#300.
   */
  searchSemantic(
    query: string,
    k: number,
    options?: SearchSemanticOptions,
  ): Promise<SemanticHit[]>;
  walkGraph(spec: GraphWalkSpec): Promise<KnowledgeNode[]>;
  getEpisodes(range: TimeRange, filter?: EpisodeFilter): Promise<Episode[]>;
  getEntitiesByType(type: MemoryEntityType, filter?: EntityFilter): Promise<KnowledgeEntity[]>;
  getTriples(subject?: string, predicate?: string, object?: string): Promise<KnowledgeTriple[]>;
  // Aggregations
  summarize(spec: SummarizeSpec): Promise<MemorySummary>;
  compress(maxTokens: number): Promise<CompressedView>;
  // Negotiation + migration
  capabilities(): Set<MemoryCapability>;
  exportAll(): AsyncIterable<MemoryRecord>;
  importAll(records: AsyncIterable<MemoryRecord>): Promise<{ imported: number; skipped: number }>;
}
