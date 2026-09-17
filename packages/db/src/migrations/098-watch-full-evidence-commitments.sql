-- Version Watch evidence commitments so new runs can bind every matched item
-- while existing v1 rows remain independently verifiable from their retained
-- snapshots. v2 retains only a bounded display sample, but its digest is
-- streamed over the complete deterministic evidence sequence by the worker.

ALTER TABLE watch_runs
  ADD COLUMN IF NOT EXISTS evidence_commitment_version INT;

-- Migration 096 commitments covered only the retained snapshot. Preserve that
-- meaning explicitly instead of reinterpreting already-written hashes.
UPDATE watch_runs
   SET evidence_commitment_version = 1
 WHERE evidence_sha256 IS NOT NULL
   AND evidence_commitment_version IS NULL;

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS
  watch_runs_evidence_commitment_version_chk CHECK (
    (evidence_sha256 IS NULL AND evidence_commitment_version IS NULL)
    OR
    (evidence_sha256 IS NOT NULL AND evidence_commitment_version IN (1, 2))
  );
