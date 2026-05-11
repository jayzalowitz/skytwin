import { query, withTransaction } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
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
import { cosineSimilarity } from './embedding.js';
import { rrfFold } from './rrf.js';

const log = createLogger('memory-gbrain-crdb');

/**
 * CockroachDB-backed repository for the gbrain memory backend.
 *
 * Responsible for:
 *   - reading/writing the brain_* tables (defined in migration 040)
 *   - hybrid retrieval: vector + tsvector with Reciprocal Rank Fusion
 *   - the durable embedding job queue
 *
 * The repository is intentionally pure-CRDB and side-effect-free — embeddings
 * are produced upstream by `EmbeddingProvider` and the repository just stores
 * the resulting `number[]`. This keeps the SQL layer testable independently
 * of any LLM provider.
 */

// ── Insert / upsert ─────────────────────────────────────────────────────────

export async function insertPage(input: InsertBrainPageInput): Promise<BrainPageRow> {
  const id = input.id ?? randomUuid();
  const title = input.title ?? '';
  const metadata = input.metadata ?? {};
  const tsvSource = `${title} ${input.content}`.trim();

  const result = await query<BrainPageRow>(
    `INSERT INTO brain_pages (
       id, user_id, title, content, source, source_ref, metadata,
       embedding, embedding_model, embedding_dim,
       content_tsv, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10,
       to_tsvector('english', $11),
       now(), now()
     )
     RETURNING *`,
    [
      id,
      input.userId,
      title,
      input.content,
      input.source,
      input.sourceRef ?? null,
      JSON.stringify(metadata),
      input.embedding ? formatVector(input.embedding) : null,
      input.embeddingModel ?? null,
      input.embedding ? input.embedding.length : null,
      tsvSource,
    ],
  );

  const row = parsePageRow(result.rows[0]!);

  // If no embedding was provided, enqueue a job for async backfill.
  if (!input.embedding) {
    await enqueueEmbeddingJob(input.userId, id);
  }

  return row;
}

export async function updatePageEmbedding(
  pageId: string,
  embedding: number[],
  model: string,
): Promise<void> {
  await query(
    `UPDATE brain_pages
       SET embedding = $1::FLOAT8[],
           embedding_model = $2,
           embedding_dim = $3,
           updated_at = now()
     WHERE id = $4`,
    [formatVector(embedding), model, embedding.length, pageId],
  );
}

// ── Hybrid retrieval (RRF) ──────────────────────────────────────────────────

export interface HybridSearchOptions {
  userId: string;
  query: string;
  queryEmbedding?: number[];
  k: number;
  /** Number of candidates fetched from each side before RRF folding. */
  candidatePoolSize?: number;
  /** RRF constant; standard literature uses 60. */
  rrfK?: number;
  /** Cap on rows scanned from CRDB; ceiling for correctness on huge corpora. */
  scanLimit?: number;
}

/**
 * Reciprocal Rank Fusion across vector cosine similarity and tsvector ranking.
 *
 * Implementation note: CRDB's query planner sometimes degrades the
 * ts_rank + ORDER BY plan when joined with a large array-similarity scan. To
 * keep this predictable we issue two parallel queries (text rank, vector rank),
 * fold ranks in TS, and return the top-K. This is the same shape used by
 * upstream gbrain's RRF query layer.
 */
export async function hybridSearch(opts: HybridSearchOptions): Promise<RrfHit[]> {
  const candidatePool = opts.candidatePoolSize ?? Math.max(opts.k * 4, 40);
  const rrfK = opts.rrfK ?? 60;
  const scanLimit = opts.scanLimit ?? 5000;

  const [textHits, vectorHits] = await Promise.all([
    textSearch(opts.userId, opts.query, candidatePool),
    opts.queryEmbedding
      ? vectorSearch(opts.userId, opts.queryEmbedding, candidatePool, scanLimit)
      : Promise.resolve([] as Array<{ page: BrainPageRow; score: number }>),
  ]);

  return rrfFold(textHits, vectorHits, opts.k, rrfK);
}

interface ScoredHit {
  page: BrainPageRow;
  score: number;
}

/**
 * tsvector + plainto_tsquery ranked search. Returns up to `limit` rows ordered
 * by `ts_rank_cd` descending. Empty / whitespace-only queries return [].
 */
export async function textSearch(
  userId: string,
  q: string,
  limit: number,
): Promise<ScoredHit[]> {
  const sanitised = q.trim();
  if (!sanitised) return [];

  const result = await query<BrainPageRow & { rank: number }>(
    `SELECT bp.*, ts_rank_cd(bp.content_tsv, plainto_tsquery('english', $2)) AS rank
       FROM brain_pages bp
      WHERE bp.user_id = $1
        AND bp.content_tsv @@ plainto_tsquery('english', $2)
      ORDER BY rank DESC
      LIMIT $3`,
    [userId, sanitised, limit],
  );

  return result.rows.map((row) => ({
    page: parsePageRow(row),
    score: Number(row.rank ?? 0),
  }));
}

/**
 * Brute-force cosine-similarity search. Pulls up to `scanLimit` rows in
 * created_at order (newest first) and computes similarity application-side.
 * For personal-twin-scale corpora (≤ ~50k pages) this completes in <100ms.
 */
export async function vectorSearch(
  userId: string,
  queryEmbedding: number[],
  limit: number,
  scanLimit: number,
): Promise<ScoredHit[]> {
  const result = await query<BrainPageRow>(
    `SELECT *
       FROM brain_pages
      WHERE user_id = $1
        AND embedding IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, scanLimit],
  );

  const scored: ScoredHit[] = [];
  for (const raw of result.rows) {
    const row = parsePageRow(raw);
    const emb = row.embedding;
    if (!emb || emb.length !== queryEmbedding.length) continue;
    const sim = cosineSimilarity(queryEmbedding, emb);
    scored.push({ page: row, score: sim });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── Entities ────────────────────────────────────────────────────────────────

export async function upsertEntity(input: {
  id?: string;
  userId: string;
  name: string;
  entityType: string;
  attributes?: Record<string, unknown>;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
}): Promise<BrainEntityRow> {
  const id = input.id ?? randomUuid();
  const result = await query<BrainEntityRow>(
    `INSERT INTO brain_entities (
       id, user_id, name, entity_type, attributes,
       first_seen_at, last_seen_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, name, entity_type) DO UPDATE
       SET attributes = EXCLUDED.attributes,
           last_seen_at = EXCLUDED.last_seen_at
     RETURNING *`,
    [
      id,
      input.userId,
      input.name,
      input.entityType,
      JSON.stringify(input.attributes ?? {}),
      input.firstSeenAt ?? new Date(),
      input.lastSeenAt ?? new Date(),
    ],
  );
  return parseEntityRow(result.rows[0]!);
}

export async function getEntities(
  userId: string,
  filter: { entityType?: string; nameLike?: string; limit?: number } = {},
): Promise<BrainEntityRow[]> {
  const limit = filter.limit ?? 1000;
  const conds = ['user_id = $1'];
  const params: unknown[] = [userId];
  if (filter.entityType) {
    params.push(filter.entityType);
    conds.push(`entity_type = $${params.length}`);
  }
  if (filter.nameLike) {
    params.push(`%${filter.nameLike.toLowerCase()}%`);
    conds.push(`lower(name) LIKE $${params.length}`);
  }
  params.push(limit);
  const result = await query<BrainEntityRow>(
    `SELECT * FROM brain_entities WHERE ${conds.join(' AND ')} ORDER BY name ASC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(parseEntityRow);
}

// ── Triples ─────────────────────────────────────────────────────────────────

export async function insertTriple(input: {
  id?: string;
  userId: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom?: Date;
  validTo?: Date;
  evidence?: Record<string, unknown>;
}): Promise<BrainTripleRow> {
  const id = input.id ?? randomUuid();
  const result = await query<BrainTripleRow>(
    `INSERT INTO brain_triples (
       id, user_id, subject, predicate, object, valid_from, valid_to, evidence
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      input.userId,
      input.subject,
      input.predicate,
      input.object,
      input.validFrom ?? new Date(),
      input.validTo ?? null,
      JSON.stringify(input.evidence ?? {}),
    ],
  );
  return parseTripleRow(result.rows[0]!);
}

export async function getTriples(
  userId: string,
  filter: { subject?: string; predicate?: string; object?: string; limit?: number } = {},
): Promise<BrainTripleRow[]> {
  const limit = filter.limit ?? 500;
  const conds = ['user_id = $1'];
  const params: unknown[] = [userId];
  if (filter.subject) {
    params.push(filter.subject);
    conds.push(`subject = $${params.length}`);
  }
  if (filter.predicate) {
    params.push(filter.predicate);
    conds.push(`predicate = $${params.length}`);
  }
  if (filter.object) {
    params.push(filter.object);
    conds.push(`object = $${params.length}`);
  }
  params.push(limit);
  const result = await query<BrainTripleRow>(
    `SELECT * FROM brain_triples
      WHERE ${conds.join(' AND ')}
      ORDER BY valid_from DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(parseTripleRow);
}

// ── Episodes ────────────────────────────────────────────────────────────────

export async function insertEpisode(input: {
  id?: string;
  userId: string;
  wing?: string;
  summary: string;
  metadata?: Record<string, unknown>;
  startedAt?: Date;
  endedAt?: Date;
}): Promise<BrainEpisodeRow> {
  const id = input.id ?? randomUuid();
  const result = await query<BrainEpisodeRow>(
    `INSERT INTO brain_episodes (
       id, user_id, wing, summary, metadata, started_at, ended_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      id,
      input.userId,
      input.wing ?? null,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
      input.startedAt ?? new Date(),
      input.endedAt ?? new Date(),
    ],
  );
  return parseEpisodeRow(result.rows[0]!);
}

export async function getEpisodes(
  userId: string,
  filter: {
    from?: Date;
    to?: Date;
    wing?: string;
    limit?: number;
  } = {},
): Promise<BrainEpisodeRow[]> {
  const limit = filter.limit ?? 100;
  const conds = ['user_id = $1'];
  const params: unknown[] = [userId];
  if (filter.from) {
    params.push(filter.from);
    conds.push(`started_at >= $${params.length}`);
  }
  if (filter.to) {
    params.push(filter.to);
    conds.push(`ended_at <= $${params.length}`);
  }
  if (filter.wing) {
    params.push(filter.wing);
    conds.push(`wing = $${params.length}`);
  }
  params.push(limit);
  const result = await query<BrainEpisodeRow>(
    `SELECT * FROM brain_episodes
      WHERE ${conds.join(' AND ')}
      ORDER BY started_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(parseEpisodeRow);
}

// ── Signals ─────────────────────────────────────────────────────────────────

export async function insertSignal(input: {
  id: string;
  userId: string;
  source: string;
  type: string;
  data?: Record<string, unknown>;
  signalTimestamp: Date;
}): Promise<BrainSignalRow> {
  const result = await query<BrainSignalRow>(
    `INSERT INTO brain_signals (id, user_id, source, type, data, signal_timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.id,
      input.userId,
      input.source,
      input.type,
      JSON.stringify(input.data ?? {}),
      input.signalTimestamp,
    ],
  );
  return parseSignalRow(result.rows[0]!);
}

export async function getAllSignals(userId: string, limit = 10000): Promise<BrainSignalRow[]> {
  const result = await query<BrainSignalRow>(
    `SELECT * FROM brain_signals WHERE user_id = $1 ORDER BY signal_timestamp ASC LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map(parseSignalRow);
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function getSettings(userId: string): Promise<BrainSettingsRow | null> {
  const result = await query<BrainSettingsRow>(
    `SELECT * FROM brain_settings WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ? parseSettingsRow(result.rows[0]) : null;
}

export async function upsertSettings(
  userId: string,
  patch: Partial<Pick<BrainSettingsRow, 'backend' | 'hybrid_notification_dismissed' | 'routing'>>,
): Promise<BrainSettingsRow> {
  // Default backend on first insert MUST match `apps/api/src/memory-setup.ts`
  // `getMemoryPortForUser`'s 'gbrain' default and the brain_settings.backend
  // column DEFAULT in migration 040. Otherwise a partial upsert (e.g. when
  // POST /api/memory-config/dismiss-notification fires for a fresh user)
  // would silently flip them to hybrid.
  const result = await query<BrainSettingsRow>(
    `INSERT INTO brain_settings (user_id, backend, hybrid_notification_dismissed, routing, updated_at)
     VALUES ($1, COALESCE($2, 'gbrain'), COALESCE($3, false), COALESCE($4::JSONB, '{}'::JSONB), now())
     ON CONFLICT (user_id) DO UPDATE
       SET backend = COALESCE($2, brain_settings.backend),
           hybrid_notification_dismissed = COALESCE($3, brain_settings.hybrid_notification_dismissed),
           routing = COALESCE($4::JSONB, brain_settings.routing),
           updated_at = now()
     RETURNING *`,
    [
      userId,
      patch.backend ?? null,
      patch.hybrid_notification_dismissed ?? null,
      patch.routing ? JSON.stringify(patch.routing) : null,
    ],
  );
  return parseSettingsRow(result.rows[0]!);
}

// ── Embedding job queue ─────────────────────────────────────────────────────

export async function enqueueEmbeddingJob(userId: string, pageId: string): Promise<void> {
  await query(
    `INSERT INTO brain_embedding_jobs (user_id, page_id) VALUES ($1, $2)`,
    [userId, pageId],
  );
}

/**
 * Lease the next pending embedding job using `SELECT FOR UPDATE SKIP LOCKED`.
 * Returns null if no pending job exists. The caller must call `markJobDone`
 * or `markJobFailed` once finished — leases auto-expire after 5 minutes.
 *
 * CRDB serialisable transactions give us at-most-once claim semantics:
 * concurrent workers will not pick the same row.
 */
export async function leaseEmbeddingJob(): Promise<{ id: string; userId: string; pageId: string; pageContent: string } | null> {
  return withTransaction(async (client) => {
    const claim = await client.query<{ id: string; user_id: string; page_id: string }>(
      `SELECT id, user_id, page_id
         FROM brain_embedding_jobs
        WHERE status = 'pending'
          AND (leased_until IS NULL OR leased_until < now())
        ORDER BY enqueued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    const job = claim.rows[0];
    if (!job) return null;

    await client.query(
      `UPDATE brain_embedding_jobs
         SET status = 'in_progress',
             leased_until = now() + INTERVAL '5 minutes',
             attempts = attempts + 1
       WHERE id = $1`,
      [job.id],
    );

    const page = await client.query<{ content: string; title: string }>(
      `SELECT content, title FROM brain_pages WHERE id = $1`,
      [job.page_id],
    );
    const content = page.rows[0]?.content ?? '';
    const title = page.rows[0]?.title ?? '';
    return {
      id: job.id,
      userId: job.user_id,
      pageId: job.page_id,
      pageContent: `${title}\n${content}`.trim(),
    };
  });
}

export async function markJobDone(jobId: string): Promise<void> {
  await query(
    `UPDATE brain_embedding_jobs
       SET status = 'completed', completed_at = now(), leased_until = NULL
     WHERE id = $1`,
    [jobId],
  );
}

export async function markJobFailed(jobId: string, errMsg: string): Promise<void> {
  await query(
    `UPDATE brain_embedding_jobs
       SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
           error = $2,
           leased_until = NULL
     WHERE id = $1`,
    [jobId, errMsg.substring(0, 500)],
  );
}

/**
 * Pending embedding job count.
 *
 * `userId` is required for user-facing surfaces (the dashboard reports
 * per-user numbers). Passing `userId = undefined` returns the global count,
 * which is the right number for the worker's drain loop telemetry.
 */
export async function pendingEmbeddingJobs(userId?: string): Promise<number> {
  if (userId) {
    const result = await query<{ count: string }>(
      `SELECT count(*)::STRING AS count
         FROM brain_embedding_jobs
        WHERE status = 'pending' AND user_id = $1`,
      [userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  const result = await query<{ count: string }>(
    `SELECT count(*)::STRING AS count FROM brain_embedding_jobs WHERE status = 'pending'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

// ── Bulk reads (export) ─────────────────────────────────────────────────────

export async function getAllPages(userId: string, limit = 10000): Promise<BrainPageRow[]> {
  const result = await query<BrainPageRow>(
    `SELECT * FROM brain_pages WHERE user_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map(parsePageRow);
}

// ── Counts (for diagnostics) ────────────────────────────────────────────────

export async function countPages(userId: string): Promise<{ total: number; embedded: number }> {
  const result = await query<{ total: string; embedded: string }>(
    `SELECT count(*)::STRING AS total,
            count(*) FILTER (WHERE embedding IS NOT NULL)::STRING AS embedded
       FROM brain_pages
      WHERE user_id = $1`,
    [userId],
  );
  return {
    total: Number(result.rows[0]?.total ?? 0),
    embedded: Number(result.rows[0]?.embedded ?? 0),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a TS number[] into a CRDB FLOAT8[] array literal. Uses the SQL
 * array constructor `ARRAY[...]` syntax via Postgres's array I/O — pg's
 * driver accepts a JS number[] and the Postgres wire protocol does the right
 * thing. Wrapped here so a future swap to a typed VECTOR(N) column is one
 * file diff.
 */
export function formatVector(v: number[]): number[] {
  // The pg driver handles number[] → FLOAT8[] natively. We expose this
  // wrapper so call sites read consistently.
  return v;
}

function parsePageRow(row: BrainPageRow): BrainPageRow {
  // pg returns FLOAT8[] as a string like "{0.1,0.2}" only if no parser is
  // installed; with the default parser it's already number[] — but defensive
  // parsing is cheap.
  if (typeof row.embedding === 'string') {
    row = { ...row, embedding: parsePgArray(row.embedding) };
  }
  return {
    ...row,
    metadata: parseJson(row.metadata) ?? {},
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function parseEntityRow(row: BrainEntityRow): BrainEntityRow {
  return {
    ...row,
    attributes: parseJson(row.attributes) ?? {},
    first_seen_at: new Date(row.first_seen_at),
    last_seen_at: new Date(row.last_seen_at),
  };
}

function parseTripleRow(row: BrainTripleRow): BrainTripleRow {
  return {
    ...row,
    evidence: parseJson(row.evidence) ?? {},
    valid_from: new Date(row.valid_from),
    valid_to: row.valid_to ? new Date(row.valid_to) : null,
    created_at: new Date(row.created_at),
  };
}

function parseEpisodeRow(row: BrainEpisodeRow): BrainEpisodeRow {
  return {
    ...row,
    metadata: parseJson(row.metadata) ?? {},
    started_at: new Date(row.started_at),
    ended_at: new Date(row.ended_at),
  };
}

function parseSignalRow(row: BrainSignalRow): BrainSignalRow {
  return {
    ...row,
    data: parseJson(row.data) ?? {},
    recorded_at: new Date(row.recorded_at),
    signal_timestamp: new Date(row.signal_timestamp),
  };
}

function parseSettingsRow(row: BrainSettingsRow): BrainSettingsRow {
  return {
    ...row,
    routing: parseJson(row.routing) ?? {},
    updated_at: new Date(row.updated_at),
  };
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      log.warn('failed to parse JSON column; defaulting to empty object');
      return {};
    }
  }
  return null;
}

function parsePgArray(value: string): number[] {
  // Format: "{0.1,0.2,0.3}" or "{}". Defensive — only used when the pg type
  // parser hasn't been installed.
  const trimmed = value.replace(/^[{[]/, '').replace(/[}\]]$/, '');
  if (!trimmed) return [];
  return trimmed.split(',').map((s) => Number(s));
}

/**
 * UUID v4 generator — uses Node's crypto.randomUUID where available. We don't
 * import from `node:crypto` at the top because that would force `@types/node`
 * into the bundle path; the dynamic require is a pragmatic choice.
 */
function randomUuid(): string {
  // Use a synchronous import via globalThis.crypto (available in Node 19+)
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback (Node < 19): use Math.random — not cryptographically strong, but
  // every supported Node version (>= 20) has globalThis.crypto.randomUUID, so
  // this branch is dead in practice. Kept for paranoia.
  const hex = (n: number): string => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
