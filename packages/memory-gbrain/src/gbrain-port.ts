import { execFileSync } from 'node:child_process';
import type {
  MemoryPort,
  MemoryCapability,
  RawSignal,
  KnowledgeEntity,
  KnowledgeTriple,
  Episode,
  SemanticHit,
  SearchSemanticOptions,
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
import { isGbrainInstalled } from './cli-detector.js';

const log = createLogger('memory-gbrain');

const GBRAIN_TIMEOUT_MS = 5000;

/**
 * Error thrown by GbrainMemoryPort for operations it does not implement.
 * Callers (typically HybridMemoryPort) catch this and route to the secondary.
 */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`GbrainMemoryPort does not implement ${method} — route to secondary`);
    this.name = 'NotImplementedError';
  }
}

/**
 * GbrainMemoryPort — a MemoryPort adapter that shells out to the `gbrain`
 * CLI for semantic and code-aware search.
 *
 * Live gbrain CLI integration is best-effort: if the CLI is not installed or
 * returns an error, all search methods return [] (empty, not an error) so the
 * HybridMemoryPort can fall back to MemPalace without disruption. The result
 * normalizer accepts both the legacy `id`/`content` shape and upstream
 * gbrain v0.50.5.0's `slug`/`chunk_text` SearchResult shape.
 *
 * Unimplemented methods (walkGraph, getEpisodes, getTriples, summarize,
 * compress, and all write methods) throw NotImplementedError. The hybrid
 * composer routes these to MemPalace.
 */
export class GbrainMemoryPort implements MemoryPort {
  private readonly installed: boolean;

  constructor() {
    this.installed = isGbrainInstalled();
    if (!this.installed) {
      log.warn('gbrain CLI not found in PATH; semantic search will return empty results');
    }
  }

  capabilities(): Set<MemoryCapability> {
    if (!this.installed) return new Set<MemoryCapability>();
    return new Set<MemoryCapability>(['semantic_search', 'code_aware_search']);
  }

  // ── Write — not implemented (route to secondary) ─────────────────

  async recordSignal(_s: RawSignal): Promise<void> {
    throw new NotImplementedError('recordSignal');
  }

  async recordEntity(_e: KnowledgeEntity): Promise<void> {
    throw new NotImplementedError('recordEntity');
  }

  async recordTriple(_t: KnowledgeTriple): Promise<void> {
    throw new NotImplementedError('recordTriple');
  }

  async recordEpisode(_e: Episode): Promise<void> {
    throw new NotImplementedError('recordEpisode');
  }

  // ── Read — semantic search via gbrain CLI ─────────────────────────

  /**
   * searchSemantic: shells out to `gbrain search --json --query="..." --limit=N`.
   *
   * Returns [] (not an error) when:
   *   - gbrain CLI is not installed
   *   - The CLI exits with a non-zero status
   *   - The shell-out times out (5 s hard limit)
   *   - The output is not valid JSON
   *
   * Never logs the query text (PII avoidance). Only logs operation name and
   * result count.
   */
  async searchSemantic(
    _query: string,
    k: number,
    options?: SearchSemanticOptions,
  ): Promise<SemanticHit[]> {
    if (!this.installed) {
      return [];
    }

    // Polyfill contract (#300): when a tier filter is set, the CLI can't
    // push the predicate, so over-fetch then narrow + slice — otherwise
    // a small `k` with a strict filter could return zero hits when the
    // unfiltered top-k happened to be all inbox-tier matches. Same shape
    // as the pre-#300 client-side filter in draft-email-setup. With no
    // filter, k is passed through 1:1.
    const tierFilter = options?.authoringTier?.length
      ? new Set(options.authoringTier)
      : null;
    const fetchLimit = tierFilter ? Math.max(k * 4, 40) : k;

    try {
      // execFileSync (no shell) — args are passed directly to argv, so the
      // user-supplied query cannot inject shell metacharacters ($(), backticks,
      // ;, &&, etc.). Do not switch back to execSync without re-evaluating.
      const raw = execFileSync(
        'gbrain',
        ['search', '--json', `--query=${_query}`, `--limit=${String(fetchLimit)}`],
        { timeout: GBRAIN_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );

      const parsed: unknown = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        log.warn('gbrain search returned non-array JSON; returning empty results', {
          resultCount: 0,
        });
        return [];
      }

      const hits: SemanticHit[] = [];
      for (const item of parsed) {
        const hit = normalizeGbrainHit(item);
        if (hit) {
          if (tierFilter) {
            const metaTier = hit.metadata?.['authoringTier'];
            if (typeof metaTier !== 'string' || !tierFilter.has(metaTier)) continue;
          }
          hits.push(hit);
          if (hits.length >= k) break;
        }
      }

      log.info('gbrain searchSemantic complete', { resultCount: hits.length });
      return hits;
    } catch (err: unknown) {
      const isTimeout =
        err instanceof Error && err.message.toLowerCase().includes('timed out');
      log.warn('gbrain search failed; returning empty results', {
        reason: isTimeout ? 'timeout' : 'error',
      });
      return [];
    }
  }

  // ── Read — not implemented (route to secondary) ───────────────────

  async walkGraph(_spec: GraphWalkSpec): Promise<KnowledgeNode[]> {
    throw new NotImplementedError('walkGraph');
  }

  async getEpisodes(_range: TimeRange, _filter?: EpisodeFilter): Promise<Episode[]> {
    throw new NotImplementedError('getEpisodes');
  }

  async getEntitiesByType(
    _type: MemoryEntityType,
    _filter?: EntityFilter,
  ): Promise<KnowledgeEntity[]> {
    throw new NotImplementedError('getEntitiesByType');
  }

  async getTriples(
    _subject?: string,
    _predicate?: string,
    _object?: string,
  ): Promise<KnowledgeTriple[]> {
    throw new NotImplementedError('getTriples');
  }

  // ── Aggregations — not implemented (route to secondary) ──────────

  async summarize(_spec: SummarizeSpec): Promise<MemorySummary> {
    throw new NotImplementedError('summarize');
  }

  async compress(_maxTokens: number): Promise<CompressedView> {
    throw new NotImplementedError('compress');
  }

  // ── Migration — not implemented ───────────────────────────────────

  async *exportAll(): AsyncIterable<MemoryRecord> {
    throw new NotImplementedError('exportAll');
  }

  async importAll(
    _records: AsyncIterable<MemoryRecord>,
  ): Promise<{ imported: number; skipped: number }> {
    throw new NotImplementedError('importAll');
  }
}

// ── Type guard for gbrain JSON output ────────────────────────────────────────

interface LegacyGbrainHit {
  id: string;
  score: number;
  content: string;
  source: string;
  metadata?: Record<string, unknown>;
}

interface CurrentGbrainHit {
  slug: string;
  score: number;
  chunk_text: string;
  source_id?: string;
  title?: string;
  type?: string;
  page_id?: number;
  chunk_id?: number;
  chunk_index?: number;
  stale?: boolean;
  metadata?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeGbrainHit(value: unknown): SemanticHit | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['id'] === 'string' &&
    typeof v['score'] === 'number' && Number.isFinite(v['score']) &&
    typeof v['content'] === 'string' &&
    typeof v['source'] === 'string'
  ) {
    const hit = v as unknown as LegacyGbrainHit;
    return {
      id: hit.id,
      score: hit.score,
      content: hit.content,
      source: hit.source,
      metadata: hit.metadata,
    };
  }

  if (
    typeof v['slug'] !== 'string' ||
    typeof v['score'] !== 'number' ||
    !Number.isFinite(v['score']) ||
    typeof v['chunk_text'] !== 'string'
  ) {
    return null;
  }

  const hit = v as unknown as CurrentGbrainHit;
  const metadata: Record<string, unknown> = isRecord(v['metadata'])
    ? { ...v['metadata'] }
    : {};
  for (const key of ['source_id', 'title', 'type'] as const) {
    const item = v[key];
    if (typeof item === 'string') metadata[key] = item;
  }
  for (const key of ['page_id', 'chunk_id', 'chunk_index'] as const) {
    const item = v[key];
    if (typeof item === 'number' && Number.isFinite(item)) metadata[key] = item;
  }
  if (typeof v['stale'] === 'boolean') metadata['stale'] = v['stale'];
  return {
    id: hit.slug,
    score: hit.score,
    content: hit.chunk_text,
    source:
      typeof hit.source_id === 'string' && hit.source_id.length > 0
        ? hit.source_id
        : hit.slug,
    metadata,
  };
}
