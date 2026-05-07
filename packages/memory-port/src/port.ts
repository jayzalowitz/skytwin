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

export interface MemoryPort {
  // Write
  recordSignal(s: RawSignal): Promise<void>;
  recordEntity(e: KnowledgeEntity): Promise<void>;
  recordTriple(t: KnowledgeTriple): Promise<void>;
  recordEpisode(e: Episode): Promise<void>;
  // Read
  searchSemantic(query: string, k: number): Promise<SemanticHit[]>;
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
