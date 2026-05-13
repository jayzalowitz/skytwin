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

/**
 * Strip display name and angle brackets from an RFC 5322 address.
 * Mirrors the inlined helper in `EmbeddedGbrainMemoryPort.buildPageMetadata`
 * and the `extractBareAddress` from `@skytwin/connectors`. Duplicated
 * locally so this module stays free of the connectors dep.
 */
function bareAddrInMemory(raw: string): string {
  if (!raw) return '';
  const angle = raw.match(/<([^>]+)>/);
  if (angle && angle[1]) return angle[1].trim().toLowerCase();
  return raw.trim().toLowerCase();
}

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

  /**
   * Mirror of `repository.computeBidirectionalThreadCounts`. Returns a
   * Map<contactAddress, bidirectionalDayCount>. The CRDB version
   * approximates threads as day-windows; the in-memory mirror does the
   * same so behaviour is identical between backends.
   */
  computeBidirectionalThreadCounts(userId: string, windowDays = 90): Map<string, number> {
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const received = new Map<string, Set<string>>();
    const sent = new Map<string, Set<string>>();
    for (const sig of this.signals.values()) {
      if (sig.user_id !== userId) continue;
      if (sig.signal_timestamp.getTime() < cutoff) continue;
      const data = sig.data as Record<string, unknown>;
      const day = sig.signal_timestamp.toISOString().slice(0, 10);
      const labels = Array.isArray(data['labels']) ? (data['labels'] as string[]) : [];
      const isSent = labels.includes('SENT');
      if (isSent) {
        // Include both `to` and `cc` — a user who only ever replies via CC
        // would otherwise show zero sent-side contacts and never reach
        // the bidirectional join.
        const toRaw = typeof data['to'] === 'string' ? (data['to'] as string) : '';
        const ccRaw = typeof data['cc'] === 'string' ? (data['cc'] as string) : '';
        const recipients = `${toRaw},${ccRaw}`.split(',').map((s) => bareAddrInMemory(s));
        for (const addr of recipients) {
          if (!addr) continue;
          if (!sent.has(addr)) sent.set(addr, new Set());
          sent.get(addr)!.add(day);
        }
      } else {
        const fromRaw = typeof data['from'] === 'string' ? (data['from'] as string) : '';
        const addr = bareAddrInMemory(fromRaw);
        if (!addr) continue;
        if (!received.has(addr)) received.set(addr, new Set());
        received.get(addr)!.add(day);
      }
    }
    const out = new Map<string, number>();
    for (const [contact, recvDays] of received) {
      if (!sent.has(contact)) continue;
      out.set(contact, recvDays.size);
    }
    return out;
  }

  /**
   * Mirror of `repository.findPagesMissingAuthoringTier`. Returns at most
   * `limit` pages whose metadata is missing `authoringTier` and whose
   * `source_ref` matches a stored signal id.
   */
  findPagesMissingAuthoringTier(
    userId: string | null,
    limit: number,
  ): Array<{ page_id: string; user_id: string; signal_data: Record<string, unknown> }> {
    const out: Array<{
      page_id: string;
      user_id: string;
      signal_data: Record<string, unknown>;
    }> = [];
    for (const page of this.pages.values()) {
      if (userId !== null && page.user_id !== userId) continue;
      const meta = (page.metadata ?? {}) as Record<string, unknown>;
      if (typeof meta['authoringTier'] === 'string') continue;
      if (!page.source_ref) continue;
      const sig = this.signals.get(page.source_ref);
      if (!sig) continue;
      out.push({
        page_id: page.id,
        user_id: page.user_id,
        signal_data: sig.data as Record<string, unknown>,
      });
      if (out.length >= limit) break;
    }
    return out;
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
      tier_weighting: patch.tier_weighting ?? existing?.tier_weighting ?? true,
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
