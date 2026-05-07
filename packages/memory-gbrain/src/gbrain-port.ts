import { execSync } from 'node:child_process';
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
 * GbrainMemoryPort — a MemoryPort skeleton that shells out to the `gbrain`
 * CLI for semantic and code-aware search.
 *
 * SKELETON: This is a partial scaffold for v1.0.5. Live gbrain CLI integration
 * is best-effort: if the CLI is not installed or returns an error, all search
 * methods return [] (empty, not an error) so the HybridMemoryPort can fall
 * back to MemPalace without disruption.
 *
 * Deferred:
 *   - CRDB driver shim (@skytwin/memory-gbrain-crdb-adapter) — v1.0.5
 *   - Full gbrain MCP integration — v1.0.5
 *   - federated_sources (gbrain v1.1+)
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
  async searchSemantic(_query: string, k: number): Promise<SemanticHit[]> {
    if (!this.installed) {
      return [];
    }

    try {
      const raw = execSync(
        `gbrain search --json --query=${JSON.stringify(_query)} --limit=${k}`,
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
        if (isGbrainHit(item)) {
          hits.push({
            id: item.id,
            score: item.score,
            content: item.content,
            source: item.source,
            metadata: item.metadata,
          });
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

interface GbrainHit {
  id: string;
  score: number;
  content: string;
  source: string;
  metadata?: Record<string, unknown>;
}

function isGbrainHit(value: unknown): value is GbrainHit {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['score'] === 'number' &&
    typeof v['content'] === 'string' &&
    typeof v['source'] === 'string'
  );
}
