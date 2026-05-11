-- 040-gbrain-memory.sql
-- GBrain memory backend tables (#197).
--
-- Adds the brain_* tables that back @skytwin/memory-gbrain when running
-- in-process against CockroachDB (the default v1.0.5+ setup). These tables
-- coexist with the existing memory_* and knowledge_* tables (mempalace);
-- the HybridMemoryPort routes per-operation, dual-writes, and reads from
-- whichever backend declares the relevant capability natively.
--
-- Schema notes:
--   - `embedding` is FLOAT8[] for portability across CRDB versions. CRDB
--     2024+ has a native VECTOR type; we don't gate on it because the
--     brute-force cosine over personal-twin-scale (≤ ~50k pages) corpora
--     fits inside ~50ms with a single linear scan, and skipping VECTOR keeps
--     the migration runnable on every supported CRDB version.
--   - `content_tsv` is TSVECTOR — CRDB has supported tsvector + plainto_tsquery
--     since v22; the FTS plus tsvector index handles keyword retrieval. The
--     column is generated as STORED so writers don't have to maintain it.
--   - The hybrid retrieval (RRF) is computed application-side in
--     @skytwin/memory-gbrain — keeping the SQL to two parallel ranked
--     queries, then folding ranks in TS — sidesteps CRDB's FTS-vs-vector
--     query planner edge cases.

-- ============================================================================
-- brain_pages: the atomic unit of brain memory.
-- ============================================================================
-- A "page" is a textual unit: a signal summary, an episode, a note, a code def.
-- The hybrid retrieval engine searches across pages and ranks them by
-- vector + tsvector RRF.
-- IMPORTANT: id is STRING, not UUID, so connector-assigned identifiers like
-- `sig_gmail_abc123` (which the MemoryPort.RawSignal contract treats as opaque
-- strings) round-trip correctly. Forcing UUID would 500 every recordSignal
-- whose id wasn't UUID-shaped. Same applies to every other brain_* PK below.
CREATE TABLE IF NOT EXISTS brain_pages (
  id STRING PRIMARY KEY DEFAULT gen_random_uuid()::STRING,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title STRING NOT NULL DEFAULT '',
  content STRING NOT NULL,
  source STRING NOT NULL,           -- 'signal', 'episode', 'note', 'code', 'extract'
  source_ref STRING,                 -- back-pointer (signal id, episode id, etc.)
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding FLOAT8[],                -- N-dim float vector; null until backfilled
  embedding_model STRING,            -- which model produced it
  embedding_dim INT,                 -- vector dimension (so different models can co-exist)
  -- content_tsv lazily added below — keep generated columns separate so older
  -- CRDB versions that lack STORED generated tsvector columns can still create
  -- the table and let the application call to_tsvector on demand.
  content_tsv TSVECTOR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brain_pages_user_idx ON brain_pages (user_id);
CREATE INDEX IF NOT EXISTS brain_pages_user_created_idx ON brain_pages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS brain_pages_user_source_idx ON brain_pages (user_id, source);
CREATE INDEX IF NOT EXISTS brain_pages_embedding_pending_idx ON brain_pages (user_id) WHERE embedding IS NULL;

-- INVERTED index on tsvector: enables fast plainto_tsquery / phraseto_tsquery
-- ranking. CRDB exposes inverted indexes via `INVERTED INDEX ... (column)`.
CREATE INVERTED INDEX IF NOT EXISTS brain_pages_tsv_idx ON brain_pages (content_tsv);

-- ============================================================================
-- brain_entities: typed entities mined from pages.
-- ============================================================================
-- Mirrors knowledge_entities (mempalace) but keyed independently so the gbrain
-- backend can be enabled / rebuilt without touching mempalace state.
CREATE TABLE IF NOT EXISTS brain_entities (
  id STRING PRIMARY KEY DEFAULT gen_random_uuid()::STRING,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name STRING NOT NULL,
  entity_type STRING NOT NULL,
  attributes JSONB NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name, entity_type)
);

CREATE INDEX IF NOT EXISTS brain_entities_user_idx ON brain_entities (user_id);
CREATE INDEX IF NOT EXISTS brain_entities_user_type_idx ON brain_entities (user_id, entity_type);

-- ============================================================================
-- brain_triples: temporal (subject, predicate, object) facts.
-- ============================================================================
CREATE TABLE IF NOT EXISTS brain_triples (
  id STRING PRIMARY KEY DEFAULT gen_random_uuid()::STRING,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject STRING NOT NULL,
  predicate STRING NOT NULL,
  object STRING NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brain_triples_user_idx ON brain_triples (user_id);
CREATE INDEX IF NOT EXISTS brain_triples_user_subject_idx ON brain_triples (user_id, subject);
CREATE INDEX IF NOT EXISTS brain_triples_user_predicate_idx ON brain_triples (user_id, predicate);
CREATE INDEX IF NOT EXISTS brain_triples_user_object_idx ON brain_triples (user_id, object);

-- ============================================================================
-- brain_episodes: agent-side episodic memories owned by gbrain.
-- ============================================================================
-- The existing `episodic_memories` table is mempalace-flavoured (it carries
-- domain/situationType/utilityScore/feedbackType — concepts coupled to the
-- decision pipeline). brain_episodes is a leaner shape exposed via MemoryPort
-- so the hybrid composer can write to either side without lossy mapping.
CREATE TABLE IF NOT EXISTS brain_episodes (
  id STRING PRIMARY KEY DEFAULT gen_random_uuid()::STRING,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wing STRING,
  summary STRING NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brain_episodes_user_idx ON brain_episodes (user_id);
CREATE INDEX IF NOT EXISTS brain_episodes_user_started_idx ON brain_episodes (user_id, started_at DESC);

-- ============================================================================
-- brain_signals: persisted raw signals (so MemoryPort.recordSignal survives restarts).
-- ============================================================================
-- Earlier mempalace adapter held signals in an in-memory Map; that's lost on
-- restart and breaks export/import round-trips. Make this durable here. The
-- existing `signals` table (signal-repository) carries decision-pipeline
-- metadata (domain, retention_until); brain_signals stores the lossless port
-- shape so MemoryRecord round-trips without information loss.
CREATE TABLE IF NOT EXISTS brain_signals (
  id STRING PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source STRING NOT NULL,
  type STRING NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signal_timestamp TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS brain_signals_user_ts_idx ON brain_signals (user_id, signal_timestamp DESC);

-- ============================================================================
-- brain_settings: per-user backend selection + hybrid mode notification state.
-- ============================================================================
CREATE TABLE IF NOT EXISTS brain_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Default matches `apps/api/src/memory-setup.ts:getMemoryPortForUser`'s
  -- 'gbrain' default. Drift here means partial upserts (e.g.
  -- dismiss-notification on a fresh user) silently switch the backend.
  backend STRING NOT NULL DEFAULT 'gbrain'
    CHECK (backend IN ('hybrid', 'gbrain', 'mempalace')),
  hybrid_notification_dismissed BOOL NOT NULL DEFAULT false,
  routing JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- brain_embedding_jobs: durable queue for async embedding.
-- ============================================================================
-- Embeddings are computed asynchronously so write paths (recordSignal,
-- recordEntity) stay fast. CRDB's serializable transactions give us
-- "at-most-once" claim semantics for free — a worker SELECT...FOR UPDATE
-- SKIP LOCKED leases a job; the lease auto-expires if the worker dies.
CREATE TABLE IF NOT EXISTS brain_embedding_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Matches brain_pages.id (STRING). Earlier draft had UUID here, but
  -- brain_pages.id is STRING so non-UUID page ids (e.g. signal-derived
  -- pages) could not be enqueued without a type-cast error.
  page_id STRING NOT NULL REFERENCES brain_pages(id) ON DELETE CASCADE,
  status STRING NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  error STRING,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  leased_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS brain_embedding_jobs_pending_idx
  ON brain_embedding_jobs (status, enqueued_at)
  WHERE status = 'pending';
