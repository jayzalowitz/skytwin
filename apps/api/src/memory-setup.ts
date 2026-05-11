/**
 * Memory backend factory for the API.
 *
 * Resolves the per-user `MemoryPort` instance the API mounts onto requests.
 * The backend is selected in this priority:
 *
 *   1. Per-user `brain_settings.backend` set via the memory settings page.
 *   2. `MEMORY_BACKEND` env var: 'gbrain' (default) | 'hybrid' | 'mempalace'.
 *
 * Default is **gbrain** — the in-process CRDB-backed embedded port. Per
 * issue #197 the gbrain backend declares semantic_search, code_aware_search,
 * temporal_triples, episodic, and graph_walk; the only mempalace-only
 * capabilities are spatial_wings and aaak_compression which the hybrid
 * composer routes via the secondary backend when enabled.
 *
 * Embedding provider selection (issue #197 AC #3 / #9):
 *   - If `OPENAI_EMBEDDING_API_KEY` (or `OPENAI_API_KEY`) is set, use
 *     OpenAI (or any compatible provider via `OPENAI_EMBEDDING_BASE_URL`).
 *     1536-dim by default.
 *   - Otherwise fall back to the deterministic hash-trick provider. Recall
 *     is modest but the system always boots — zero-config dev.
 */

import { createLogger } from '@skytwin/core';
import {
  EmbeddedGbrainMemoryPort,
  HashEmbeddingProvider,
  OpenAiEmbeddingProvider,
  hasExternalGbrainConfig,
  isGbrainInstalled,
  type EmbeddingProvider,
} from '@skytwin/memory-gbrain';
import {
  HybridMemoryPort,
  type RoutingRules,
} from '@skytwin/memory-hybrid';
import { MemPalaceMemoryPort, type MemPalaceRepos } from '@skytwin/memory-mempalace';
import type { MemoryPort } from '@skytwin/memory-port';
import {
  getSettings as getBrainSettings,
  upsertSettings as upsertBrainSettings,
} from '@skytwin/memory-gbrain-crdb-adapter';
import { mempalaceRepository } from '@skytwin/db';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type {
  EpisodeContext,
  EpisodeOutcome,
  KnowledgeEntity,
  KnowledgeTriple,
  EpisodicMemory,
} from '@skytwin/shared-types';

const log = createLogger('memory-setup');

export type BackendChoice = 'hybrid' | 'gbrain' | 'mempalace';

export interface ResolvedBackend {
  port: MemoryPort;
  /** Effective backend choice (after applying per-user overrides). */
  backend: BackendChoice;
  /** Hybrid port if `backend === 'hybrid'`, for diagnostics/notification. */
  hybrid: HybridMemoryPort | null;
}

/**
 * Construct the embedding provider. Singleton — embedded providers are
 * stateless so re-using the instance saves the OpenAI fetch options object.
 */
let cachedEmbedding: EmbeddingProvider | null = null;
export function getEmbeddingProvider(): EmbeddingProvider {
  if (cachedEmbedding) return cachedEmbedding;
  const apiKey = process.env['OPENAI_EMBEDDING_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (apiKey) {
    const baseUrl = process.env['OPENAI_EMBEDDING_BASE_URL'];
    const model = process.env['OPENAI_EMBEDDING_MODEL'] ?? 'text-embedding-3-small';
    log.info('using OpenAI-compatible embedding provider', { model });
    cachedEmbedding = new OpenAiEmbeddingProvider({
      apiKey,
      model,
      ...(baseUrl ? { baseUrl } : {}),
    });
    return cachedEmbedding;
  }
  log.info('using hash-trick embedding provider (no OPENAI_EMBEDDING_API_KEY set)');
  cachedEmbedding = new HashEmbeddingProvider();
  return cachedEmbedding;
}

/**
 * Build a real `MemPalaceMemoryPort` wired to `mempalaceRepository`. The
 * adapter expects a `MemPalaceRepos` object whose port-interface methods use
 * positional argument signatures; we shim each call through to the
 * `mempalaceRepository` (which uses input-object signatures).
 *
 * Surface coverage:
 *   - knowledgeGraph: upsertEntity / getEntities / findEntity / addTriple /
 *     queryTriples / invalidateTriple — all live mempalaceRepository methods.
 *   - episode: createEpisode / getEpisodes / getEpisodeByDecision /
 *     updateEpisode / searchEpisodes — all live.
 *   - palace / closet / entityCode / closetPersistence / tripleSearch — these
 *     are touched only by the legacy mempalace classes, not by the MemoryPort
 *     surface (verified by reading `packages/memory-mempalace/src/adapter.ts`).
 *     Stubbed with `throw` so any new caller reaching them fails loud rather
 *     than silently returning empty.
 *
 * Replaces the previous `StubMempalacePort` that returned `[]` everywhere —
 * which meant selecting `mempalace` (or relying on the hybrid secondary)
 * dropped all the legacy mempalace data on the floor.
 */
function buildMempalacePort(): MemPalaceMemoryPort {
  const repos: MemPalaceRepos = {
    knowledgeGraph: {
      async upsertEntity(
        userId: string,
        name: string,
        entityType: string,
        properties: Record<string, unknown>,
        aliases: string[],
      ): Promise<KnowledgeEntity> {
        const row = await mempalaceRepository.upsertEntity({
          userId,
          name,
          entityType,
          properties,
          aliases,
        });
        return mapEntityRow(row);
      },
      async getEntities(userId: string, entityType?: string): Promise<KnowledgeEntity[]> {
        const rows = await mempalaceRepository.getEntities(userId, entityType);
        return rows.map(mapEntityRow);
      },
      async findEntity(userId: string, name: string): Promise<KnowledgeEntity | null> {
        const row = await mempalaceRepository.findEntity(userId, name);
        return row ? mapEntityRow(row) : null;
      },
      async addTriple(
        userId: string,
        subject: string,
        predicate: string,
        object: string,
        validFrom: Date,
        confidence: ConfidenceLevel,
        sourceDrawerId?: string,
      ): Promise<KnowledgeTriple> {
        const row = await mempalaceRepository.addTriple({
          userId,
          subject,
          predicate,
          object,
          validFrom,
          confidence,
          ...(sourceDrawerId ? { sourceDrawerId } : {}),
        });
        return mapTripleRow(row);
      },
      async queryTriples(userId: string, options) {
        const rows = await mempalaceRepository.queryTriples(userId, options);
        return rows.map(mapTripleRow);
      },
      async invalidateTriple(tripleId: string, validTo?: Date): Promise<void> {
        await mempalaceRepository.invalidateTriple(tripleId, validTo);
      },
    },
    episode: {
      async createEpisode(input) {
        // mempalaceRepository.createEpisode accepts the same shape minus a
        // sub-type widening: it stores outcome as Record<string,unknown>
        // (the table column is JSONB), but the port surface uses the typed
        // EpisodeOutcome. They serialise identically; cast through unknown.
        const row = await mempalaceRepository.createEpisode({
          userId: input.userId,
          situationSummary: input.situationSummary,
          domain: input.domain,
          situationType: input.situationType,
          contextSnapshot: input.contextSnapshot as unknown as Record<string, unknown>,
          ...(input.actionTaken !== undefined ? { actionTaken: input.actionTaken } : {}),
          ...(input.outcome
            ? { outcome: input.outcome as unknown as Record<string, unknown> }
            : {}),
          ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
          ...(input.signalIds !== undefined ? { signalIds: input.signalIds } : {}),
          ...(input.drawerIds !== undefined ? { drawerIds: input.drawerIds } : {}),
          ...(input.utilityScore !== undefined ? { utilityScore: input.utilityScore } : {}),
        });
        return mapEpisodeRow(row);
      },
      async getEpisodes(userId, options) {
        const rows = await mempalaceRepository.getEpisodes(userId, options);
        return rows.map(mapEpisodeRow);
      },
      async getEpisodeByDecision(decisionId: string): Promise<EpisodicMemory | null> {
        const row = await mempalaceRepository.getEpisodeByDecision(decisionId);
        return row ? mapEpisodeRow(row) : null;
      },
      async updateEpisode(id, patch) {
        // The repo's Partial<Pick<...>> shape is narrower than the port's
        // (Record vs typed outcome). Re-cast.
        const repoPatch: Parameters<typeof mempalaceRepository.updateEpisode>[1] = {};
        if (patch.outcome !== undefined) {
          repoPatch.outcome = patch.outcome as unknown as Record<string, unknown>;
        }
        if (patch.feedbackType !== undefined) repoPatch.feedback_type = patch.feedbackType;
        if (patch.feedbackDetail !== undefined) repoPatch.feedback_detail = patch.feedbackDetail;
        if (patch.utilityScore !== undefined) repoPatch.utility_score = patch.utilityScore;
        if (patch.actionTaken !== undefined) repoPatch.action_taken = patch.actionTaken;
        if (patch.drawerIds !== undefined) repoPatch.drawer_ids = patch.drawerIds;
        const row = await mempalaceRepository.updateEpisode(id, repoPatch);
        return row ? mapEpisodeRow(row) : null;
      },
      async searchEpisodes(userId, terms, limit) {
        const rows = await mempalaceRepository.searchEpisodes(userId, terms, limit);
        return rows.map(mapEpisodeRow);
      },
    },
    palace: throwingPalacePort(),
    closet: throwingClosetPort(),
    tripleSearch: {
      queryTriples: async (userId, options) => {
        const rows = await mempalaceRepository.queryTriples(userId, options);
        return rows.map(mapTripleRow);
      },
    },
    entityCode: throwingEntityCodePort(),
    closetPersistence: {
      createCloset: async () => {
        throw new Error('mempalace closetPersistence.createCloset not used via MemoryPort');
      },
    } as unknown as MemPalaceRepos['closetPersistence'],
  };

  return new MemPalaceMemoryPort(repos as unknown as MemPalaceRepos);
}

function mapEntityRow(row: {
  id: string;
  user_id: string;
  name: string;
  entity_type: string;
  properties: unknown;
  aliases: unknown;
  created_at: unknown;
  updated_at: unknown;
}): KnowledgeEntity {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    entityType: row.entity_type as KnowledgeEntity['entityType'],
    properties:
      typeof row.properties === 'string'
        ? (JSON.parse(row.properties) as Record<string, unknown>)
        : ((row.properties as Record<string, unknown>) ?? {}),
    aliases: Array.isArray(row.aliases) ? (row.aliases as string[]) : [],
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapTripleRow(row: {
  id: string;
  user_id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: unknown;
  valid_to: unknown;
  confidence: string;
  source_closet_id: string | null;
  source_drawer_id: string | null;
  extracted_at: unknown;
}): KnowledgeTriple {
  const out: KnowledgeTriple = {
    id: row.id,
    userId: row.user_id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    validFrom: toDate(row.valid_from),
    validTo: row.valid_to ? toDate(row.valid_to) : null,
    confidence: row.confidence as ConfidenceLevel,
    extractedAt: toDate(row.extracted_at),
  };
  if (row.source_closet_id) out.sourceClosetId = row.source_closet_id;
  if (row.source_drawer_id) out.sourceDrawerId = row.source_drawer_id;
  return out;
}

function mapEpisodeRow(row: {
  id: string;
  user_id: string;
  domain: string;
  situation_type: string;
  situation_summary: string;
  action_taken: string | null;
  context_snapshot: unknown;
  outcome: unknown;
  feedback_type: string | null;
  utility_score: unknown;
  created_at: unknown;
  updated_at: unknown;
}): EpisodicMemory {
  return {
    id: row.id,
    userId: row.user_id,
    domain: row.domain,
    situationType: row.situation_type,
    situationSummary: row.situation_summary,
    actionTaken: row.action_taken ?? undefined,
    contextSnapshot:
      typeof row.context_snapshot === 'string'
        ? (JSON.parse(row.context_snapshot) as EpisodeContext)
        : ((row.context_snapshot as EpisodeContext) ?? ({} as EpisodeContext)),
    outcome:
      row.outcome === null || row.outcome === undefined
        ? undefined
        : typeof row.outcome === 'string'
          ? (JSON.parse(row.outcome) as EpisodeOutcome)
          : (row.outcome as EpisodeOutcome),
    feedbackType: row.feedback_type as EpisodicMemory['feedbackType'],
    signalIds: [],
    drawerIds: [],
    utilityScore: typeof row.utility_score === 'number' ? row.utility_score : Number(row.utility_score),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return new Date(0);
}

/**
 * Palace / Closet / EntityCode methods that the MemoryPort surface never
 * touches. They exist on `MemPalaceRepos` because the legacy classes
 * (Palace, Compressor) take them — but those classes are wired against the
 * existing `/api/mempalace` routes, not against the `MemoryPort` adapter.
 * Throwing here surfaces any future regression where a new MemoryPort code
 * path quietly starts depending on a mempalace primitive we never wired.
 */
function throwingPalacePort(): MemPalaceRepos['palace'] {
  const fail = (method: string) => async () => {
    throw new Error(`mempalace palace.${method} not used via MemoryPort`);
  };
  return {
    createWing: fail('createWing'),
    getWings: async () => [],
    getWingByName: async () => null,
    createRoom: fail('createRoom'),
    getRooms: async () => [],
    getRoomByName: async () => null,
    getRoomsByTopic: async () => [],
    createDrawer: fail('createDrawer'),
    getDrawers: async () => [],
    searchDrawers: async () => [],
    findDrawerBySourceId: async () => null,
    deleteDrawer: async () => false,
    upsertTunnel: fail('upsertTunnel'),
    getTunnels: async () => [],
    getStatus: async () => ({
      userId: '',
      totalDrawers: 0,
      totalClosets: 0,
      totalTunnels: 0,
      totalEntities: 0,
      totalTriples: 0,
      lastUpdated: new Date(0),
    }),
  } as unknown as MemPalaceRepos['palace'];
}

function throwingClosetPort(): MemPalaceRepos['closet'] {
  return {
    createCloset: async () => {
      throw new Error('mempalace closet.createCloset not used via MemoryPort');
    },
    getClosetsForRoom: async () => [],
    getClosetsForWing: async () => [],
  } as unknown as MemPalaceRepos['closet'];
}

function throwingEntityCodePort(): MemPalaceRepos['entityCode'] {
  return {
    upsertEntityCode: async () => {
      throw new Error('mempalace entityCode.upsertEntityCode not used via MemoryPort');
    },
    getEntityCodes: async () => [],
  } as unknown as MemPalaceRepos['entityCode'];
}

/**
 * Construct the per-user MemoryPort. The default is gbrain (pure embedded).
 * Per-user `brain_settings.backend` overrides the env default.
 */
export async function getMemoryPortForUser(userId: string): Promise<ResolvedBackend> {
  const envDefault = parseBackendChoice(process.env['MEMORY_BACKEND']);
  let chosen = envDefault ?? 'gbrain';

  // Per-user override.
  try {
    const settings = await getBrainSettings(userId);
    if (settings?.backend) chosen = settings.backend;
  } catch (err) {
    log.warn('failed to load per-user brain settings; using env default', {
      userId,
      reason: err instanceof Error ? err.name : 'unknown',
    });
  }

  const embedding = getEmbeddingProvider();
  switch (chosen) {
    case 'mempalace': {
      return {
        port: buildMempalacePort(),
        backend: 'mempalace',
        hybrid: null,
      };
    }
    case 'hybrid': {
      const primary = new EmbeddedGbrainMemoryPort({ userId, embedding, backend: 'crdb' });
      const secondary = buildMempalacePort();
      const hybrid = new HybridMemoryPort({
        primary,
        secondary,
        routing: defaultRoutingRules(),
      });
      return { port: hybrid, backend: 'hybrid', hybrid };
    }
    case 'gbrain':
    default: {
      return {
        port: new EmbeddedGbrainMemoryPort({ userId, embedding, backend: 'crdb' }),
        backend: 'gbrain',
        hybrid: null,
      };
    }
  }
}

export function defaultRoutingRules(): RoutingRules {
  return {
    searchSemantic: 'primary',
    code_aware_search: 'primary',
    walkGraph: 'primary',
    getEpisodes: 'primary',
    getTriples: 'primary',
    summarize: 'secondary',
    compress: 'secondary',
  };
}

function parseBackendChoice(s: string | undefined): BackendChoice | null {
  if (s === 'hybrid' || s === 'gbrain' || s === 'mempalace') return s;
  return null;
}

/**
 * Persist a backend selection. Used by the /api/memory-config route.
 */
export async function setUserBackend(userId: string, backend: BackendChoice): Promise<void> {
  await upsertBrainSettings(userId, { backend });
}

/**
 * Heuristic the dashboard uses to surface a "your existing gbrain detected"
 * prompt — lets the user opt into hybrid mode.
 */
export function suggestHybridUpgrade(): {
  suggest: boolean;
  externalConfigPresent: boolean;
  cliInPath: boolean;
} {
  const externalConfigPresent = hasExternalGbrainConfig();
  const cliInPath = isGbrainInstalled();
  return {
    suggest: externalConfigPresent || cliInPath,
    externalConfigPresent,
    cliInPath,
  };
}

/**
 * Reset the cached embedding provider — used by tests that mutate env vars.
 */
export function _resetEmbeddingCacheForTests(): void {
  cachedEmbedding = null;
}
