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
import type { MemoryPort, MemoryCapability } from '@skytwin/memory-port';
import {
  getSettings as getBrainSettings,
  upsertSettings as upsertBrainSettings,
} from '@skytwin/memory-gbrain-crdb-adapter';

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
 * Stub MemoryPort that returns empty results everywhere. Used as the secondary
 * in hybrid mode when MemPalace is unavailable, and as the standalone port
 * when the user explicitly selects 'mempalace' but no real adapter is wired.
 *
 * We ship the stub rather than refusing to load: the existing mempalace
 * routes (apps/api/src/routes/mempalace.ts) still work for legacy callers
 * who depend on them — the stub here is just for the MemoryPort surface
 * which is currently mostly consumed via gbrain. A v1.1 follow-up will
 * replace this with a real MemPalaceMemoryPort wired to mempalaceRepository.
 */
class StubMempalacePort implements MemoryPort {
  capabilities(): Set<MemoryCapability> {
    return new Set<MemoryCapability>(['spatial_wings', 'aaak_compression']);
  }
  async recordSignal() {}
  async recordEntity() {}
  async recordTriple() {}
  async recordEpisode() {}
  async searchSemantic() { return []; }
  async walkGraph() { return []; }
  async getEpisodes() { return []; }
  async getEntitiesByType() { return []; }
  async getTriples() { return []; }
  async summarize() {
    return { text: '', tokenCount: 0, citations: [] };
  }
  async compress() {
    return { entries: [], totalSourcesCompressed: 0 };
  }
  async *exportAll() {
    // empty — no records to export
  }
  async importAll() {
    return { imported: 0, skipped: 0 };
  }
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
        port: new StubMempalacePort(),
        backend: 'mempalace',
        hybrid: null,
      };
    }
    case 'hybrid': {
      const primary = new EmbeddedGbrainMemoryPort({ userId, embedding, backend: 'crdb' });
      const secondary = new StubMempalacePort();
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
