export type MemoryCapability =
  | 'semantic_search'
  | 'graph_walk'
  | 'episodic'
  | 'spatial_wings'
  | 'aaak_compression'
  | 'temporal_triples'
  | 'code_aware_search'
  | 'federated_sources';

export interface RawSignal {
  id: string;
  source: string;
  type: string;
  timestamp: Date;
  data: Record<string, unknown>;
}

export type MemoryEntityType =
  | 'person' | 'place' | 'project' | 'concept' | 'organization' | 'event' | 'service';

export interface KnowledgeEntity {
  id: string;
  userId: string;
  name: string;
  entityType: MemoryEntityType;
  attributes?: Record<string, unknown>;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface KnowledgeTriple {
  id: string;
  userId: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: Date;
  validTo?: Date;
  evidence?: { signalId?: string; sourceRef?: string };
}

export interface Episode {
  id: string;
  userId: string;
  wing?: string;
  startedAt: Date;
  endedAt: Date;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface SemanticHit {
  id: string;
  score: number;
  content: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeNode {
  id: string;
  type: 'entity' | 'triple';
  data: KnowledgeEntity | KnowledgeTriple;
}

export interface TimeRange { from: Date; to: Date; }
export interface EpisodeFilter { wing?: string; minDurationMs?: number; }
export interface EntityFilter { name?: string; }

export interface GraphWalkSpec {
  startNodeId: string;
  maxDepth: number;
  edgeFilter?: { predicate?: string };
}

export interface SummarizeSpec {
  scope: 'user-profile' | 'recent-week' | 'recent-day' | 'wing';
  wingName?: string;
  maxTokens?: number;
}

export interface MemorySummary {
  text: string;
  tokenCount: number;
  citations: Array<{ ref: string; kind: string }>;
}

export interface CompressedView {
  entries: Array<{ summary: string; sourceCount: number; periodFrom: Date; periodTo: Date }>;
  totalSourcesCompressed: number;
}

export interface MemoryRecord {
  kind: 'signal' | 'entity' | 'triple' | 'episode';
  payload: RawSignal | KnowledgeEntity | KnowledgeTriple | Episode;
}
