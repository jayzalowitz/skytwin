-- 065-worker-dead-letter.sql
-- Dead-letter queue for worker background jobs (#407, parent #357).
--
-- The worker's global background jobs (domain extraction, embedding
-- backfill, briefing generation, federation sync, tier backfill, …)
-- catch their own errors and continue. That keeps the poll loop alive
-- through a transient failure, but it also means a job that fails on
-- EVERY tick has no retry budget and no operator visibility — it just
-- logs a warning and silently never makes progress.
--
-- This table is the dead-letter sink. After a job exceeds its retry
-- budget (consecutive failures across poll cycles), the worker writes
-- one row here capturing the job name, the final error, the attempt
-- count, and a JSON `context` blob (the job's input, if any). An
-- operator inspects the queue via GET /api/admin/dead-letter and can
-- mark a row replayed once the underlying cause is fixed.
--
-- NOT user-scoped: these are process-global jobs with no single owner
-- user (embedding backfill drains a shared queue; domain extraction
-- iterates all users). `context` may name a user when one applies, but
-- the row's identity is (job_name, dead_lettered_at), not a user.
--
-- `status` is a narrow union: 'pending' (awaiting operator action),
-- 'replayed' (operator re-queued it), 'discarded' (operator dismissed
-- it as not worth replaying). Only 'pending' rows surface in the
-- default admin list.
CREATE TABLE IF NOT EXISTS worker_dead_letter (
    id                UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    job_name          STRING NOT NULL,
    error_message     STRING NOT NULL,
    attempts          INT NOT NULL DEFAULT 1,
    context           JSONB,
    status            STRING NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'replayed', 'discarded')),
    dead_lettered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at       TIMESTAMPTZ
);

-- The admin list query is "newest pending first"; this partial index
-- keeps that scan cheap as discarded/replayed history accumulates.
CREATE INDEX IF NOT EXISTS worker_dead_letter_pending_idx
    ON worker_dead_letter (dead_lettered_at DESC)
    WHERE status = 'pending';

-- Supports the per-job-name filter the admin endpoint accepts.
CREATE INDEX IF NOT EXISTS worker_dead_letter_job_idx
    ON worker_dead_letter (job_name, dead_lettered_at DESC);
