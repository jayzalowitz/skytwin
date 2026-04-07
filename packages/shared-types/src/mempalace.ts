import { ConfidenceLevel } from './enums.js';

// ============================================================================
// Palace Structure — the spatial metaphor for organized memory
// ============================================================================

/**
 * A wing is a top-level grouping in the memory palace.
 * Wings represent major life domains, projects, or people.
 */
export interface MemoryWing {
  id: string;
  userId: string;
  name: string;
  description: string;
  /** Domains this wing covers (maps to SkyTwin domains like 'email', 'calendar') */
  domains: string[];
  drawerCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A room is a topic within a wing. Rooms that appear in multiple wings
 * create "tunnels" — cross-domain connections.
 */
export interface MemoryRoom {
  id: string;
  wingId: string;
  name: string;
  description: string;
  /** Which hall(s) this room's memories belong to */
  halls: MemoryHall[];
  drawerCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Halls categorize memory types within a room.
 */
export type MemoryHall =
  | 'facts'        // Factual knowledge about the user's world
  | 'events'       // Things that happened (episodic)
  | 'discoveries'  // Insights and learned patterns
  | 'preferences'  // What the user likes/dislikes
  | 'advice'       // Guidance derived from past decisions
  | 'diary';       // Agent's own observations and notes

/**
 * A drawer is an individual memory chunk — the atomic unit of storage.
 * Drawers live inside rooms and are tagged with a hall type.
 */
export interface MemoryDrawer {
  id: string;
  roomId: string;
  wingId: string;
  userId: string;
  hall: MemoryHall;
  content: string;
  /** Structured metadata for filtering and retrieval */
  metadata: DrawerMetadata;
  /** Relevance score from last retrieval (not persisted, query-time only) */
  relevanceScore?: number;
  /** Source that produced this memory */
  sourceType: DrawerSource;
  sourceId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Where a drawer's content originated.
 */
export type DrawerSource =
  | 'signal'       // From an incoming signal/event
  | 'decision'     // From a decision outcome
  | 'feedback'     // From user feedback
  | 'inference'    // From the inference engine
  | 'explicit'     // User explicitly told us
  | 'mined';       // Extracted by the memory miner

/**
 * Structured metadata attached to every drawer.
 */
export interface DrawerMetadata {
  domain?: string;
  situationType?: string;
  people?: string[];
  emotionMarkers?: string[];
  tags?: string[];
  decisionId?: string;
  signalIds?: string[];
  temporalContext?: {
    timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
    dayOfWeek?: number;
    isWorkHours?: boolean;
  };
  /** Importance weight 0-1, influences retrieval ranking */
  importance: number;
}

/**
 * A closet is a compressed summary of multiple drawers.
 * Uses the AAAK (compressed dialect) format for token efficiency.
 */
export interface MemoryCloset {
  id: string;
  roomId: string;
  wingId: string;
  userId: string;
  /** Compressed content in AAAK dialect */
  compressedContent: string;
  /** IDs of drawers that were compressed into this closet */
  sourceDrawerIds: string[];
  drawerCount: number;
  /** Approximate token count of the compressed content */
  tokenCount: number;
  createdAt: Date;
}

/**
 * A tunnel is a cross-wing connection. When the same topic (room name)
 * appears in multiple wings, a tunnel links them.
 */
export interface MemoryTunnel {
  id: string;
  userId: string;
  /** The shared topic that connects the wings */
  topic: string;
  /** Room IDs in different wings that share this topic */
  connectedRoomIds: string[];
  /** Wing IDs connected by this tunnel */
  connectedWingIds: string[];
  strength: number;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Knowledge Graph — entities and temporal fact triples
// ============================================================================

/**
 * An entity in the knowledge graph (a person, place, project, concept).
 */
export interface KnowledgeEntity {
  id: string;
  userId: string;
  name: string;
  entityType: 'person' | 'place' | 'project' | 'concept' | 'organization' | 'event';
  /** Structured properties of the entity */
  properties: Record<string, unknown>;
  /** Alternate names or spellings */
  aliases: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A fact triple in the knowledge graph with temporal validity.
 * "Subject predicate Object" — e.g., "Alice works_at Acme" valid from 2025-01 to present.
 */
export interface KnowledgeTriple {
  id: string;
  userId: string;
  subject: string;
  predicate: string;
  object: string;
  /** When this fact became true */
  validFrom: Date;
  /** When this fact stopped being true (null = still valid) */
  validTo: Date | null;
  confidence: ConfidenceLevel;
  /** Which closet or drawer this was extracted from */
  sourceClosetId?: string;
  sourceDrawerId?: string;
  extractedAt: Date;
}

// ============================================================================
// Episodic Memory — links decisions, signals, and outcomes into episodes
// ============================================================================

/**
 * An episodic memory links a decision situation with its context, action,
 * outcome, and user feedback into a single retrievable episode.
 */
export interface EpisodicMemory {
  id: string;
  userId: string;
  /** The situation that triggered this episode */
  situationSummary: string;
  domain: string;
  situationType: string;
  /** Key context at the time of the episode */
  contextSnapshot: EpisodeContext;
  /** What action was taken (or not taken) */
  actionTaken?: string;
  /** How it turned out */
  outcome?: EpisodeOutcome;
  /** User's reaction */
  feedbackType?: 'approve' | 'reject' | 'correct' | 'ignore' | 'undo';
  feedbackDetail?: string;
  /** IDs linking back to the source records */
  decisionId?: string;
  signalIds: string[];
  drawerIds: string[];
  /** How useful this episode was for future decisions */
  utilityScore: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A snapshot of the context at the time of an episode.
 */
export interface EpisodeContext {
  people?: string[];
  timeOfDay?: string;
  dayOfWeek?: number;
  urgency?: string;
  /** Key preferences that were active */
  activePreferences?: Array<{ domain: string; key: string; value: unknown }>;
  /** Any patterns that were relevant */
  activePatterns?: string[];
  /** Free-form context notes */
  notes?: string;
}

/**
 * The outcome of an episode.
 */
export interface EpisodeOutcome {
  success: boolean;
  description: string;
  /** Did the user have to intervene? */
  userIntervened: boolean;
  /** What would have been better, if anything */
  betterAlternative?: string;
}

// ============================================================================
// Memory Stack — the 4-layer retrieval system
// ============================================================================

/**
 * The four layers of the memory stack, from always-loaded to deep search.
 */
export enum MemoryLayer {
  /** ~100 tokens: core identity, always loaded */
  L0_IDENTITY = 'l0_identity',
  /** ~500-800 tokens: essential story, always loaded */
  L1_ESSENTIAL = 'l1_essential',
  /** ~200-500 tokens each: on-demand per topic/wing */
  L2_ON_DEMAND = 'l2_on_demand',
  /** Unlimited: full semantic search across all drawers */
  L3_DEEP_SEARCH = 'l3_deep_search',
}

/**
 * A wake-up context is the combined L0+L1 layers — what the system
 * loads at the start of every decision cycle.
 */
export interface WakeUpContext {
  userId: string;
  /** L0: Core identity summary */
  identity: string;
  /** L1: Essential story — top patterns, key preferences, recent episodes */
  essentialStory: string;
  /** Approximate total token count */
  tokenCount: number;
  generatedAt: Date;
}

/**
 * Result of a memory search (L3 deep search).
 */
export interface MemorySearchResult {
  drawers: MemoryDrawer[];
  episodes: EpisodicMemory[];
  triples: KnowledgeTriple[];
  /** Total items found before limit */
  totalFound: number;
  searchedAt: Date;
}

/**
 * Result of an on-demand recall (L2).
 */
export interface RecallResult {
  wingName: string;
  closets: MemoryCloset[];
  recentDrawers: MemoryDrawer[];
  relevantEpisodes: EpisodicMemory[];
  tokenCount: number;
}

// ============================================================================
// AAAK Compression — entity codes and flags for compact memory encoding
// ============================================================================

/**
 * An entity code mapping for AAAK compression.
 * E.g., { code: 'ALC', fullName: 'Alice Chen', entityId: '...' }
 */
export interface EntityCode {
  code: string;
  fullName: string;
  entityId?: string;
}

/**
 * Flags used in AAAK compressed content to mark memory significance.
 */
export type AAAKFlag =
  | 'ORIGIN'     // Where something started
  | 'CORE'       // Fundamental to user's identity/preferences
  | 'SENSITIVE'  // Handle with care
  | 'PIVOT'      // Moment where behavior changed
  | 'GENESIS'    // First occurrence
  | 'DECISION'   // A decision point
  | 'TECHNICAL'; // Technical/domain-specific content

// ============================================================================
// Palace Status — overview of the memory palace state
// ============================================================================

/**
 * Overall status of a user's memory palace.
 */
export interface PalaceStatus {
  userId: string;
  wingCount: number;
  roomCount: number;
  drawerCount: number;
  closetCount: number;
  tunnelCount: number;
  entityCount: number;
  tripleCount: number;
  episodeCount: number;
  oldestMemory?: Date;
  newestMemory?: Date;
}
