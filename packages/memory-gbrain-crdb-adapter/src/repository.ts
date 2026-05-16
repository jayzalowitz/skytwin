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

/**
 * Merge a partial metadata patch into `brain_pages.metadata`, scoped to
 * the owning user. Uses CRDB's JSONB `||` concat-merge so existing keys
 * are overwritten but other keys are preserved. Used by the per-page
 * pin/hide actions (#251 privacy follow-up).
 *
 * Keys with a value of `null` in `patch` are treated as a *delete*
 * request — they're removed from `metadata` rather than written as a
 * JSON-null. `jsonb ||` would otherwise store `{"userOverride": null}`
 * which would (a) clutter the row indefinitely and (b) confuse any
 * downstream code that distinguishes "key absent" from "key is null".
 *
 * Returns the affected row count. A return value of 0 means the page
 * wasn't found or belonged to a different user — the route layer
 * surfaces that as 404. The `user_id` predicate is load-bearing — it
 * stops a caller from mutating another user's pages even if they hold
 * a guessable page id.
 */
export async function updatePageMetadata(
  userId: string,
  pageId: string,
  patch: Record<string, unknown>,
): Promise<number> {
  // Split the patch into "set" entries (non-null values) and "drop"
  // keys (null values). Set entries go through JSONB ||; drop keys go
  // through repeated JSONB - operators so the column shape stays clean.
  const setPatch: Record<string, unknown> = {};
  const dropKeys: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) dropKeys.push(k);
    else setPatch[k] = v;
  }
  // Build the metadata expression: start from existing column, apply
  // each drop key via `- 'key'`, then merge the set patch.
  let expr = `COALESCE(metadata, '{}'::JSONB)`;
  const params: unknown[] = [pageId, userId];
  for (const key of dropKeys) {
    params.push(key);
    expr = `${expr} - $${params.length}`;
  }
  const hasSet = Object.keys(setPatch).length > 0;
  if (hasSet) {
    params.push(JSON.stringify(setPatch));
    expr = `${expr} || $${params.length}::JSONB`;
  }
  const result = await query(
    `UPDATE brain_pages
       SET metadata = ${expr},
           updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    params,
  );
  return result.rowCount ?? 0;
}

/**
 * Find pages whose metadata is missing `authoringTier` and that have a
 * matching brain_signals row (so the worker can reclassify from the
 * stored signal data). Used by the tier-backfill worker (#251 follow-up).
 *
 * Returns rows scoped to a single user when `userId` is provided, or all
 * users when called with `null`. The page's `source_ref` carries the
 * signal id (`sig_gmail_*`), so we join brain_pages → brain_signals on
 * `id = source_ref`. Pages without a matching signal row are skipped —
 * those came from a non-signal write path (episode, entity) and don't
 * have classifiable email headers.
 *
 * Limit is mandatory and caps the worker's per-pass work — the worker's
 * default batch size is 200; callers can pass any value (lower for tests,
 * higher if you're catching up a large back-catalog manually).
 */
export interface PageMissingTierRow {
  page_id: string;
  user_id: string;
  signal_data: Record<string, unknown>;
}

export async function findPagesMissingAuthoringTier(
  userId: string | null,
  limit: number,
): Promise<PageMissingTierRow[]> {
  const userFilter = userId === null ? '' : 'AND p.user_id = $2';
  const params: unknown[] = userId === null ? [limit] : [limit, userId];
  const result = await query<PageMissingTierRow>(
    `SELECT p.id AS page_id, p.user_id AS user_id, s.data AS signal_data
       FROM brain_pages p
       JOIN brain_signals s ON s.id = p.source_ref
      WHERE p.metadata->>'authoringTier' IS NULL
        ${userFilter}
      LIMIT $1`,
    params,
  );
  return result.rows.map((row) => ({
    page_id: row.page_id,
    user_id: row.user_id,
    // Reuse the file-local `parseJson` helper so a single malformed/corrupt
    // signal row can't blow up the whole worker pass. parseJson returns
    // null on JSON.parse failure; we coerce to {} so the worker logs the
    // row as "unreclassifiable" rather than crashing.
    signal_data: parseJson(row.signal_data) ?? {},
  }));
}

/**
 * Bulk-hide every brain_page where `metadata.fromAddress` matches the
 * given sender. Used by the per-sender "stop indexing this address"
 * action (#251 privacy follow-up). Returns the affected row count so
 * the UI can show "hid N pages from X".
 *
 * Address match is exact-equality after lowering — the indexer stamps
 * `fromAddress` lowercased at write time, so this query doesn't have
 * to do anything case-aware.
 */
export async function hideAllPagesFromSender(
  userId: string,
  fromAddress: string,
): Promise<number> {
  const result = await query(
    `UPDATE brain_pages
       SET metadata = COALESCE(metadata, '{}'::JSONB) || '{"userOverride":"hidden"}'::JSONB,
           updated_at = now()
     WHERE user_id = $1
       AND metadata->>'fromAddress' = $2`,
    [userId, fromAddress.toLowerCase()],
  );
  return result.rowCount ?? 0;
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
  /**
   * Optional post-fold scoring hook (#251 Layer 2). When set, every
   * accumulated rrfScore is multiplied by `tierWeight(page.metadata)` before
   * the final sort. A multiplier of 0 drops the page entirely (used by
   * `metadata.userOverride: 'hidden'`).
   */
  tierWeight?: (metadata: unknown) => number;
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

  return rrfFold(textHits, vectorHits, opts.k, rrfK, {
    ...(opts.tierWeight ? { tierWeight: opts.tierWeight } : {}),
  });
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

/**
 * Compute bidirectional thread counts per contact address for a user
 * over the last N days. A "bidirectional thread" means the user both
 * SENT a message to and RECEIVED a message from the same thread (or
 * the same contact, in the simpler approximation we use here).
 *
 * Used by the relationship-tier backfill worker (#251 Phase 2). Returns
 * `Map<contactAddress, threadCount>` keyed by lower-cased contact
 * address. Contacts the user only ever received from (or only sent to)
 * have count 0 → `relationshipTier = 'stranger'`.
 *
 * Implementation detail: we approximate "bidirectional thread" as the
 * SAME-DAY INTERSECTION — "the number of distinct days on which the
 * user both SENT TO and RECEIVED FROM the same contact." Per-thread
 * granularity (via `In-Reply-To`/`References` chain walking) would be
 * more accurate; same-day-intersection is the cheap-and-correct proxy
 * that matches the four-band granularity we actually need. The earlier
 * implementation counted "any sent-anywhere in the window" — a single
 * sent message + 10 received-days would count as 10 same-day exchanges.
 * The intersection is the strictly correct shape.
 */
export async function computeBidirectionalThreadCounts(
  userId: string,
  windowDays = 90,
): Promise<Map<string, number>> {
  // Address extraction must mirror `extractBareAddress` in
  // `packages/connectors/src/authoring-tier.ts` and the inline helper in
  // `EmbeddedGbrainMemoryPort.buildPageMetadata`, otherwise the contact
  // keys here won't match `metadata.fromAddress` on `brain_pages` (which
  // is what the worker reads when classifying each page). Two pieces:
  //
  //   1. From `"Display Name <addr@x.com>"`, pull out the inside-angle
  //      portion. `regexp_replace(..., '.*<([^>]+)>.*', '\1')` returns
  //      the captured group when matched, OR the original string
  //      unchanged when not matched (raw `addr@x.com` with no brackets).
  //   2. `to`/`cc` are comma-separated lists. `string_to_array` + lateral
  //      `unnest` splits them; we then apply the same bracket extraction
  //      per-element. Without this, multi-recipient sent emails
  //      contribute zero matchable contacts.
  const sql = `
    WITH user_signals AS (
      SELECT
        data,
        signal_timestamp,
        DATE_TRUNC('day', signal_timestamp) AS day
      FROM brain_signals
      WHERE user_id = $1
        AND signal_timestamp > now() - ($2 || ' days')::INTERVAL
        AND source = 'gmail'
    ),
    received AS (
      SELECT
        LOWER(TRIM(regexp_replace(data->>'from', '.*<([^>]+)>.*', '\\1'))) AS contact,
        day
      FROM user_signals
      WHERE data->>'from' IS NOT NULL
        AND data->>'from' != ''
        -- COALESCE the @> result: when labels is NULL/missing the
        -- predicate yields NULL, which is falsy in WHERE and silently
        -- drops the row from BOTH the received AND sent CTEs (since
        -- received uses NOT (NULL) = NULL = falsy too). Treat missing
        -- labels as "not SENT" so received still picks it up, matching
        -- the in-memory mirror which reads labels as [] when absent.
        AND NOT COALESCE(data->'labels' @> '"SENT"'::JSONB, false)
    ),
    sent_recipients AS (
      SELECT
        TRIM(recip) AS recip_raw,
        day
      FROM user_signals,
        LATERAL unnest(
          string_to_array(
            COALESCE(data->>'to', '') || ',' || COALESCE(data->>'cc', ''),
            ','
          )
        ) AS recip
      WHERE COALESCE(data->'labels' @> '"SENT"'::JSONB, false)
    ),
    sent AS (
      SELECT
        LOWER(TRIM(regexp_replace(recip_raw, '.*<([^>]+)>.*', '\\1'))) AS contact,
        day
      FROM sent_recipients
      WHERE recip_raw != ''
    )
    -- INNER JOIN on (contact, day) -- only the days where the contact
    -- appears in BOTH the received and sent sets count. Without the
    -- "s.day = r.day" predicate the join is the per-contact Cartesian
    -- product, so COUNT(DISTINCT r.day) returns every received day as
    -- long as any sent activity exists for that contact anywhere in
    -- the window. That is the bug #281 fixed: the relationship tier was
    -- promoting "got 10 newsletters back, replied once at month-start"
    -- to core.
    SELECT
      r.contact AS contact,
      COUNT(DISTINCT r.day) AS bidirectional_days
    FROM received r
    INNER JOIN sent s ON s.contact = r.contact AND s.day = r.day
    WHERE r.contact != ''
    GROUP BY r.contact
  `;
  const result = await query<{ contact: string; bidirectional_days: string }>(sql, [
    userId,
    String(windowDays),
  ]);
  const out = new Map<string, number>();
  for (const row of result.rows) {
    if (!row.contact) continue;
    out.set(row.contact, Number(row.bidirectional_days));
  }
  return out;
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
): Promise<BrainSettingsRow> {
  // Default backend on first insert MUST match `apps/api/src/memory-setup.ts`
  // `getMemoryPortForUser`'s 'gbrain' default and the brain_settings.backend
  // column DEFAULT in migration 040. Otherwise a partial upsert (e.g. when
  // POST /api/memory-config/dismiss-notification fires for a fresh user)
  // would silently flip them to hybrid.
  const result = await query<BrainSettingsRow>(
    `INSERT INTO brain_settings (
       user_id, backend, hybrid_notification_dismissed, routing,
       tier_weighting, tier_calibration, updated_at
     )
     VALUES (
       $1,
       COALESCE($2, 'gbrain'),
       COALESCE($3, false),
       COALESCE($4::JSONB, '{}'::JSONB),
       COALESCE($5, true),
       COALESCE($6, 'normal'),
       now()
     )
     ON CONFLICT (user_id) DO UPDATE
       SET backend = COALESCE($2, brain_settings.backend),
           hybrid_notification_dismissed = COALESCE($3, brain_settings.hybrid_notification_dismissed),
           routing = COALESCE($4::JSONB, brain_settings.routing),
           tier_weighting = COALESCE($5, brain_settings.tier_weighting),
           tier_calibration = COALESCE($6, brain_settings.tier_calibration),
           updated_at = now()
     RETURNING *`,
    [
      userId,
      patch.backend ?? null,
      patch.hybrid_notification_dismissed ?? null,
      patch.routing ? JSON.stringify(patch.routing) : null,
      patch.tier_weighting ?? null,
      patch.tier_calibration ?? null,
    ],
  );
  return parseSettingsRow(result.rows[0]!);
}

/**
 * Count the user_sent_* pages in the last N days. Used to compute the
 * calibration band (#251). Cheap — uses the existing user-id + created_at
 * index plus an inline filter on the metadata JSONB field.
 */
export async function countUserSentPages(
  userId: string,
  windowDays = 90,
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::STRING AS count
       FROM brain_pages
      WHERE user_id = $1
        AND created_at > now() - ($2 || ' days')::INTERVAL
        AND metadata->>'authoringTier' IN ('user_sent_originated', 'user_sent_reply')`,
    [userId, String(windowDays)],
  );
  return Number(result.rows[0]?.count ?? 0);
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

/**
 * Most recently created pages for a user, newest first. Used by the
 * memory dashboard to show the user a snippet of "what your twin just
 * indexed" — including the authoring tier badge from `metadata`.
 */
export async function getRecentPages(
  userId: string,
  limit = 10,
): Promise<BrainPageRow[]> {
  const result = await query<BrainPageRow>(
    `SELECT * FROM brain_pages WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
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

/**
 * Raw shape pg can hand us before the FLOAT8[] parser normalizes things.
 * `embedding` can come back as a `number[]` (default) or the bare
 * `"{0.1,0.2}"` array literal (when the array parser isn't installed or
 * on some pg-compatible drivers). `parsePageRow` narrows it.
 */
type RawBrainPageRow = Omit<BrainPageRow, 'embedding'> & {
  embedding: number[] | string | null;
};

function parsePageRow(raw: RawBrainPageRow): BrainPageRow {
  const embedding =
    typeof raw.embedding === 'string' ? parsePgArray(raw.embedding) : raw.embedding;
  return {
    ...raw,
    embedding,
    metadata: parseJson(raw.metadata) ?? {},
    created_at: new Date(raw.created_at),
    updated_at: new Date(raw.updated_at),
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
  // Defensive fallbacks for installs that haven't yet applied migration 043
  // (tier_weighting / tier_calibration). A SELECT * on the pre-043 schema
  // returns rows without those columns, which surface as undefined in the
  // TS row object. Treat the runtime values as their migration defaults so
  // downstream code never has to null-check.
  return {
    ...row,
    routing: parseJson(row.routing) ?? {},
    tier_weighting: typeof row.tier_weighting === 'boolean' ? row.tier_weighting : true,
    tier_calibration: row.tier_calibration ?? 'normal',
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
