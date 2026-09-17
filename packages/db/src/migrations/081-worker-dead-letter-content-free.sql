-- Make the installation-global worker dead-letter queue content-free.
--
-- Legacy job names were accepted as arbitrary strings, and error_message/context
-- could contain credentials, prompts, user identifiers, or complete job payloads.
-- Preserve lifecycle metadata while replacing every legacy diagnostic value with
-- a non-content-bearing code and dropping the source-capable columns entirely.

ALTER TABLE worker_dead_letter
  ADD COLUMN IF NOT EXISTS job_code STRING NOT NULL DEFAULT 'legacy-redacted';

ALTER TABLE worker_dead_letter
  ADD COLUMN IF NOT EXISTS error_code STRING NOT NULL DEFAULT 'legacy-redacted';

ALTER TABLE worker_dead_letter
  ADD COLUMN IF NOT EXISTS correlation_id UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE worker_dead_letter ALTER COLUMN job_code DROP DEFAULT;
ALTER TABLE worker_dead_letter ALTER COLUMN error_code DROP DEFAULT;
ALTER TABLE worker_dead_letter ALTER COLUMN correlation_id DROP DEFAULT;

ALTER TABLE worker_dead_letter
  ADD CONSTRAINT IF NOT EXISTS worker_dead_letter_job_code_check
  CHECK (job_code IN (
    'metrics-rollup',
    'changelog-poll',
    'domain-extraction',
    'capability-inference',
    'watch-scheduler',
    'federation-sync',
    'embedding-backfill',
    'tier-backfill',
    'relationship-tier-backfill',
    'memory-action-loop',
    'briefing-generator-daily',
    'briefing-generator-weekly',
    'promotion-eligibility-check',
    'legacy-redacted'
  ));

ALTER TABLE worker_dead_letter
  ADD CONSTRAINT IF NOT EXISTS worker_dead_letter_error_code_check
  CHECK (error_code IN ('job-failed', 'legacy-redacted'));

DROP INDEX IF EXISTS worker_dead_letter@worker_dead_letter_job_idx;

ALTER TABLE worker_dead_letter DROP COLUMN IF EXISTS error_message;
ALTER TABLE worker_dead_letter DROP COLUMN IF EXISTS context;
ALTER TABLE worker_dead_letter DROP COLUMN IF EXISTS job_name;

CREATE INDEX IF NOT EXISTS worker_dead_letter_job_code_idx
  ON worker_dead_letter (job_code, dead_lettered_at DESC);
