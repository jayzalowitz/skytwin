-- 039-model-downloads.sql
-- Model download tracking for embedded LLM auto-fetch (#187 AC#2).
--
-- Each row tracks one download of a GGUF artifact named in the
-- `@skytwin/embedded-llm` registry. The downloader streams in chunks,
-- updates `bytes_downloaded` periodically, and survives API restart
-- via DB persistence: any row with status='downloading' on boot is
-- transitioned to 'paused' so the user can manually resume.
--
-- Why DB-backed and not just in-memory: 2-9GB downloads can run for
-- 10+ minutes. An API restart mid-download (deploy, OOM, crash) would
-- otherwise lose all progress. With this table the user sees a
-- "paused — click resume" UX and the partial bytes on disk are still
-- valid (Range request resumes from where we left off).

CREATE TABLE IF NOT EXISTS model_downloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Registry id (e.g. 'qwen-2.5-3b-q4'). Not a foreign key — the
  -- registry lives in the `@skytwin/embedded-llm` package, not in DB.
  model_id STRING NOT NULL,
  -- Absolute path on the API host's filesystem where the final GGUF
  -- will land. We download to `<target_path>.partial` and atomically
  -- rename on success.
  target_path STRING NOT NULL,
  -- Total bytes per registry (matches registry.approxBytes at start,
  -- gets corrected to Content-Length on first response if different).
  total_bytes INT8 NOT NULL,
  bytes_downloaded INT8 NOT NULL DEFAULT 0,
  -- SHA-256 hex (64 chars) from registry. Verified after download
  -- completes; mismatch → status='failed'. Empty / all-zeros = skip
  -- verification (placeholder hashes in v1 registry).
  sha256_expected STRING NOT NULL,
  status STRING NOT NULL CHECK (status IN (
    'pending', 'downloading', 'paused', 'verifying', 'installing', 'complete', 'failed', 'cancelled'
  )),
  error STRING,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS model_downloads_user_all_idx
  ON model_downloads (user_id, started_at DESC);

-- Partial UNIQUE index enforces "at most one active download per (user,
-- model)" at the DB level. Without this, two concurrent /downloads/start
-- calls can both pass the application-layer findActive() check and
-- INSERT two rows that race on the same .partial file.
CREATE UNIQUE INDEX IF NOT EXISTS model_downloads_user_active_uniq
  ON model_downloads (user_id, model_id)
  WHERE status NOT IN ('complete', 'failed', 'cancelled');
