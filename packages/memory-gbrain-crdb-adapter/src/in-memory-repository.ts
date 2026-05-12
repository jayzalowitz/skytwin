/**
 * In-memory implementation of the brain_* repository surface.
 *
 * Used by unit tests and (optionally) by `EmbeddedGbrainMemoryPort` in
 * environments without a CRDB instance. The wire-format and method shapes
 * mirror `repository.ts` so swapping between the two is a one-import change.
 *
 * Indexing strategy:
 *   - Pages: linear scans for both vector and FTS. Personal-twin scale.
 *   - FTS: token-set intersection with optional bigram boost.
 *   - Vector: cosine similarity against the provided embedding.
 *
 * The fold logic re-uses `rrfFold` from `./repository.js` so the ranking
 * semantics are identical between in-memory and CRDB modes — that's a
 * load-bearing invariant: tests that pin RRF behaviour should give the same
 * answers whichever backend they run against.
 */

import type {
  BrainPageRow,
  BrainEntityRow,
  BrainTripleRow,
  BrainEpisodeRow,
  BrainSignalRow,
  BrainSettingsRow,
  RrfHit,
  InsertBrainPageInput,
} from './types.js';
import { cosineSimilarity, tokenise } from './embedding.js';
import { rrfFold } from './rrf.js';

interface ScoredHit {
  page: BrainPageRow;
  score: number;
}

/**
 * `InMemoryBrainStore` is a single-process, single-test-friendly stand-in for
 * the CRDB-backed repository. It implements every method the EmbeddedGbrainMemoryPort
 * needs from the repository module. Behaviour deviates from CRDB only where
 * CRDB-specific features (tsvector ranking) are best-effort approximated.
 */
export class InMemoryBrainStore {
  readonly pages = new Map<string, BrainPageRow>();
  readonly entities = new Map<string, BrainEntityRow>();
  readonly triples = new Map<string, BrainTripleRow>();
  readonly episodes = new Map<string, BrainEpisodeRow>();
  readonly signals = new Map<string, BrainSignalRow>();
  readonly settings = new Map<string, BrainSettingsRow>();

  // Embedding job queue
  readonly jobs: Array<{
    id: string;
    userId: string;
    pageId: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    leasedUntil?: Date;
    attempts: number;
    error?: string;
  }> = [];

  private idCounter = 0;
  private genId(): string {
    this.idCounter++;
    return `mem-${this.idCounter}-${Date.now().toString(36)}`;
  }

  // ── Pages ─────────────────────────────────────────────────────────

  insertPage(input: InsertBrainPageInput): BrainPageRow {
    const id = input.id ?? this.genId();
    const now = new Date();
    const row: BrainPageRow = {
      id,
      user_id: input.userId,
      title: input.title ?? '',
      content: input.content,
      source: input.source,
      source_ref: input.sourceRef ?? null,
      metadata: input.metadata ?? {},
      embedding: input.embedding ?? null,
      embedding_model: input.embeddingModel ?? null,
      embedding_dim: input.embedding ? input.embedding.length : null,
      created_at: now,
      updated_at: now,
    };
    this.pages.set(id, row);

    if (!input.embedding) {
      this.jobs.push({
        id: this.genId(),
        userId: input.userId,
        pageId: id,
        status: 'pending',
        attempts: 0,
      });
    }
    return row;
  }

  updatePageEmbedding(pageId: string, embedding: number[], model: string): void {
    const row = this.pages.get(pageId);
    if (!row) return;
    this.pages.set(pageId, {
      ...row,
      embedding,
      embedding_model: model,
      embedding_dim: embedding.length,
      updated_at: new Date(),
    });
  }

  textSearch(userId: string, q: string, limit: number): ScoredHit[] {
    const queryTokens = new Set(tokenise(q));
    if (queryTokens.size === 0) return [];

    const scored: ScoredHit[] = [];
    for (const page of this.pages.values()) {
      if (page.user_id !== userId) continue;
      const docTokens = tokenise(`${page.title} ${page.content}`);
      let overlap = 0;
      for (const t of docTokens) if (queryTokens.has(t)) overlap++;
      if (overlap === 0) continue;
      // Mimic ts_rank — scale by overlap / total tokens, with a small log
      // damping for very long docs (TF-IDF-ish without IDF).
      const score = overlap / Math.max(1, Math.log2(2 + docTokens.length));
      scored.push({ page, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  vectorSearch(userId: string, queryEmbedding: number[], limit: number): ScoredHit[] {
    const scored: ScoredHit[] = [];
    for (const page of this.pages.values()) {
      if (page.user_id !== userId) continue;
      const emb = page.embedding;
      if (!emb || emb.length !== queryEmbedding.length) continue;
      scored.push({ page, score: cosineSimilarity(queryEmbedding, emb) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  hybridSearch(opts: {
    userId: string;
    query: string;
    queryEmbedding?: number[];
    k: number;
    candidatePoolSize?: number;
    rrfK?: number;
    tierWeight?: (metadata: unknown) => number;
  }): RrfHit[] {
    const pool = opts.candidatePoolSize ?? Math.max(opts.k * 4, 40);
    const rrfK = opts.rrfK ?? 60;
    const text = this.textSearch(opts.userId, opts.query, pool);
    const vec = opts.queryEmbedding
      ? this.vectorSearch(opts.userId, opts.queryEmbedding, pool)
      : [];
    return rrfFold(text, vec, opts.k, rrfK, {
      ...(opts.tierWeight ? { tierWeight: opts.tierWeight } : {}),
    });
  }

  /** Same calibration helper as the CRDB repo; mirrors the SQL count. */
  countUserSentPages(userId: string, windowDays = 90): number {
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    let n = 0;
    for (const p of this.pages.values()) {
      if (p.user_id !== userId) continue;
      if (p.created_at.getTime() < cutoff) continue;
      const tier = (p.metadata as Record<string, unknown>)?.['authoringTier'];
      if (tier === 'user_sent_originated' || tier === 'user_sent_reply') n++;
    }
    return n;
  }

  getAllPages(userId: string): BrainPageRow[] {
    return [...this.pages.values()]
      .filter((p) => p.user_id === userId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  /** Mirror of `repository.getRecentPages`. Newest first. */
  getRecentPages(userId: string, limit = 10): BrainPageRow[] {
    return [...this.pages.values()]
      .filter((p) => p.user_id === userId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, limit);
  }

  /**
   * Mirror of `repository.updatePageMetadata`. Returns row count. Treats
   * `null` values in `patch` as a delete-request — matches the SQL helper
   * which uses `jsonb - 'key'` for those, so downstream consumers can't
   * tell the in-memory and CRDB paths apart.
   */
  updatePageMetadata(
    userId: string,
    pageId: string,
    patch: Record<string, unknown>,
  ): number {
    const page = this.pages.get(pageId);
    if (!page || page.user_id !== userId) return 0;
    const next = { ...(page.metadata as Record<string, unknown>) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    page.metadata = next;
    page.updated_at = new Date();
    return 1;
  }

  /** Mirror of `repository.hideAllPagesFromSender`. */
  hideAllPagesFromSender(userId: string, fromAddress: string): number {
    const target = fromAddress.toLowerCase();
    let n = 0;
    for (const page of this.pages.values()) {
      if (page.user_id !== userId) continue;
      const meta = (page.metadata ?? {}) as Record<string, unknown>;
      if (meta['fromAddress'] !== target) continue;
      page.metadata = { ...meta, userOverride: 'hidden' };
      page.updated_at = new Date();
      n++;
    }
    return n;
  }

  countPages(userId: string): { total: number; embedded: number } {
    let total = 0;
    let embedded = 0;
    for (const p of this.pages.values()) {
      if (p.user_id !== userId) continue;
      total++;
      if (p.embedding) embedded++;
    }
    return { total, embedded };
  }

  // ── Entities ──────────────────────────────────────────────────────

  upsertEntity(input: {
    id?: string;
    userId: string;
    name: string;
    entityType: string;
    attributes?: Record<string, unknown>;
    firstSeenAt?: Date;
    lastSeenAt?: Date;
  }): BrainEntityRow {
    const key = `${input.userId}:${input.name}:${input.entityType}`;
    const existing = [...this.entities.values()].find(
      (e) => `${e.user_id}:${e.name}:${e.entity_type}` === key,
    );
    if (existing) {
      const updated: BrainEntityRow = {
        ...existing,
        attributes: input.attributes ?? existing.attributes,
        last_seen_at: input.lastSeenAt ?? new Date(),
      };
      this.entities.set(updated.id, updated);
      return updated;
    }
    const row: BrainEntityRow = {
      id: input.id ?? this.genId(),
      user_id: input.userId,
      name: input.name,
      entity_type: input.entityType,
      attributes: input.attributes ?? {},
      first_seen_at: input.firstSeenAt ?? new Date(),
      last_seen_at: input.lastSeenAt ?? new Date(),
    };
    this.entities.set(row.id, row);
    return row;
  }

  getEntities(
    userId: string,
    filter: { entityType?: string; nameLike?: string; limit?: number } = {},
  ): BrainEntityRow[] {
    const limit = filter.limit ?? 1000;
    const needle = filter.nameLike?.toLowerCase();
    const out = [...this.entities.values()]
      .filter((e) => e.user_id === userId)
      .filter((e) => !filter.entityType || e.entity_type === filter.entityType)
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit);
    return out;
  }

  // ── Triples ───────────────────────────────────────────────────────

  insertTriple(input: {
    id?: string;
    userId: string;
    subject: string;
    predicate: string;
    object: string;
    validFrom?: Date;
    validTo?: Date;
    evidence?: Record<string, unknown>;
  }): BrainTripleRow {
    const row: BrainTripleRow = {
      id: input.id ?? this.genId(),
      user_id: input.userId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      valid_from: input.validFrom ?? new Date(),
      valid_to: input.validTo ?? null,
      evidence: input.evidence ?? {},
      created_at: new Date(),
    };
    this.triples.set(row.id, row);
    return row;
  }

  getTriples(
    userId: string,
    filter: { subject?: string; predicate?: string; object?: string; limit?: number } = {},
  ): BrainTripleRow[] {
    const limit = filter.limit ?? 500;
    return [...this.triples.values()]
      .filter((t) => t.user_id === userId)
      .filter((t) => !filter.subject || t.subject === filter.subject)
      .filter((t) => !filter.predicate || t.predicate === filter.predicate)
      .filter((t) => !filter.object || t.object === filter.object)
      .sort((a, b) => b.valid_from.getTime() - a.valid_from.getTime())
      .slice(0, limit);
  }

  // ── Episodes ──────────────────────────────────────────────────────

  insertEpisode(input: {
    id?: string;
    userId: string;
    wing?: string;
    summary: string;
    metadata?: Record<string, unknown>;
    startedAt?: Date;
    endedAt?: Date;
  }): BrainEpisodeRow {
    const now = new Date();
    const row: BrainEpisodeRow = {
      id: input.id ?? this.genId(),
      user_id: input.userId,
      wing: input.wing ?? null,
      summary: input.summary,
      metadata: input.metadata ?? {},
      started_at: input.startedAt ?? now,
      ended_at: input.endedAt ?? now,
    };
    this.episodes.set(row.id, row);
    return row;
  }

  getEpisodes(
    userId: string,
    filter: { from?: Date; to?: Date; wing?: string; limit?: number } = {},
  ): BrainEpisodeRow[] {
    const limit = filter.limit ?? 100;
    return [...this.episodes.values()]
      .filter((e) => e.user_id === userId)
      .filter((e) => !filter.from || e.started_at.getTime() >= filter.from.getTime())
      .filter((e) => !filter.to || e.ended_at.getTime() <= filter.to.getTime())
      .filter((e) => !filter.wing || e.wing === filter.wing)
      .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
      .slice(0, limit);
  }

  // ── Signals ───────────────────────────────────────────────────────

  insertSignal(input: {
    id: string;
    userId: string;
    source: string;
    type: string;
    data?: Record<string, unknown>;
    signalTimestamp: Date;
  }): BrainSignalRow {
    if (this.signals.has(input.id)) {
      throw new Error(`duplicate signal id: ${input.id}`);
    }
    const row: BrainSignalRow = {
      id: input.id,
      user_id: input.userId,
      source: input.source,
      type: input.type,
      data: input.data ?? {},
      recorded_at: new Date(),
      signal_timestamp: input.signalTimestamp,
    };
    this.signals.set(row.id, row);
    return row;
  }

  getAllSignals(userId: string): BrainSignalRow[] {
    return [...this.signals.values()]
      .filter((s) => s.user_id === userId)
      .sort((a, b) => a.signal_timestamp.getTime() - b.signal_timestamp.getTime());
  }

  // ── Settings ──────────────────────────────────────────────────────

  getSettings(userId: string): BrainSettingsRow | null {
    return this.settings.get(userId) ?? null;
  }

  upsertSettings(
    userId: string,
    patch: Partial<
      Pick<
        BrainSettingsRow,
        | 'backend'
        | 'hybrid_notification_dismissed'
        | 'routing'
        | 'tier_weighting'
        | 'tier_calibration'
      >
    >,
  ): BrainSettingsRow {
    const existing = this.settings.get(userId);
    const merged: BrainSettingsRow = {
      user_id: userId,
      // Default matches `apps/api/src/memory-setup.ts` and migration 040.
      backend: patch.backend ?? existing?.backend ?? 'gbrain',
      hybrid_notification_dismissed:
        patch.hybrid_notification_dismissed ?? existing?.hybrid_notification_dismissed ?? false,
      routing: patch.routing ?? existing?.routing ?? {},
      tier_weighting: patch.tier_weighting ?? existing?.tier_weighting ?? false,
      tier_calibration: patch.tier_calibration ?? existing?.tier_calibration ?? 'normal',
      updated_at: new Date(),
    };
    this.settings.set(userId, merged);
    return merged;
  }

  // ── Embedding job queue ───────────────────────────────────────────

  enqueueEmbeddingJob(userId: string, pageId: string): void {
    this.jobs.push({
      id: this.genId(),
      userId,
      pageId,
      status: 'pending',
      attempts: 0,
    });
  }

  leaseEmbeddingJob(): {
    id: string;
    userId: string;
    pageId: string;
    pageContent: string;
  } | null {
    const now = Date.now();
    const candidate = this.jobs.find(
      (j) =>
        j.status === 'pending' &&
        (!j.leasedUntil || j.leasedUntil.getTime() < now),
    );
    if (!candidate) return null;
    candidate.status = 'in_progress';
    candidate.attempts++;
    candidate.leasedUntil = new Date(now + 5 * 60 * 1000);
    const page = this.pages.get(candidate.pageId);
    return {
      id: candidate.id,
      userId: candidate.userId,
      pageId: candidate.pageId,
      pageContent: `${page?.title ?? ''}\n${page?.content ?? ''}`.trim(),
    };
  }

  markJobDone(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId);
    if (job) job.status = 'completed';
  }

  markJobFailed(jobId: string, errMsg: string): void {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return;
    job.error = errMsg;
    job.status = job.attempts >= 3 ? 'failed' : 'pending';
    job.leasedUntil = undefined;
  }

  pendingEmbeddingJobs(userId?: string): number {
    return this.jobs.filter(
      (j) => j.status === 'pending' && (!userId || j.userId === userId),
    ).length;
  }
}
