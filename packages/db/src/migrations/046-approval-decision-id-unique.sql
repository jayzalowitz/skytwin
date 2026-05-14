-- 046-approval-decision-id-unique.sql
-- Enforce one approval_request per decision.
--
-- Root cause of the "every email shows twice" bug: when the same signal was
-- ingested more than once (two concurrent worker processes, each with its
-- own per-process in-memory SignalDeduper that cannot see the other's
-- emissions -- also reachable via a worker restart or an at-least-once
-- delivery retry), the decision layer absorbed it (decisionRepository.create
-- is idempotent on signal_id), but approvalRepository.create had no guard --
-- so every re-ingestion stacked another approval_request and the dashboard
-- showed every email twice.
--
-- Both creation paths (apps/api/src/routes/events.ts, assistant.ts) create
-- exactly one approval per decision, so a second row for the same
-- decision_id is always a re-ingestion duplicate.
--
-- DEPLOY ORDERING: run this migration BEFORE the matching
-- approvalRepository.create change (which uses ON CONFLICT (decision_id)).
-- Run it with signal ingestion quiesced where possible -- a worker still
-- inserting duplicates concurrently can re-introduce a duplicate between
-- step 1 and step 2. Step 3 catches that case and fails the migration
-- loudly rather than leaving the index uncreated.

-- Step 1: drop duplicate approval_requests, keeping ONE row per decision_id.
-- Survivor is chosen by (resolved-before-pending, earliest requested_at, id):
--   * a row the user already acted on (status != 'pending') is kept over a
--     still-pending duplicate, so an approve/reject is never discarded even
--     if the user happened to act on the later-created copy;
--   * among rows with the same pending-ness, the earliest requested_at wins;
--   * id (the primary key) is the final tie-break.
-- That triple is a strict total order per decision_id, so exactly one row
-- survives per decision -- the predicate can never delete every row for a
-- decision. The CASE maps pending -> 1, resolved -> 0 so resolved sorts first.
DELETE FROM approval_requests a
WHERE EXISTS (
  SELECT 1 FROM approval_requests b
  WHERE b.decision_id = a.decision_id
    AND (
      CASE WHEN b.status = 'pending' THEN 1 ELSE 0 END,
      b.requested_at,
      b.id
    ) < (
      CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END,
      a.requested_at,
      a.id
    )
);

-- Step 2: enforce the invariant. approvalRepository.create uses
-- ON CONFLICT (decision_id) DO NOTHING, so re-ingestion is a transparent
-- no-op instead of a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_decision_id_unique
  ON approval_requests (decision_id);

-- Step 3: fail loudly if a correct unique index on decision_id is not in
-- place. CockroachDB reports a CREATE UNIQUE INDEX that hits residual
-- duplicates as SQLSTATE 23505, which the migration runner's idempotency
-- guard treats as "already applied" and skips -- so without this check a
-- failed index build would leave the migration reporting success with no
-- index, and the new ON CONFLICT (decision_id) code would then error on
-- every insert. The guard verifies the index exists AND is unique AND is
-- keyed on decision_id as its first column (not merely that some index of
-- that name exists -- CREATE ... IF NOT EXISTS would skip past a stale or
-- non-unique namesake). force_error raises SQLSTATE UE001, which the runner
-- cannot swallow, so the migration fails where it should.
SELECT crdb_internal.force_error(
  'UE001',
  'migration 046: a unique index on approval_requests(decision_id) is not in place. Residual duplicates likely blocked the index build. Re-run with signal ingestion stopped.'
)
WHERE NOT EXISTS (
  SELECT 1 FROM [SHOW INDEXES FROM approval_requests]
  WHERE index_name = 'idx_approval_requests_decision_id_unique'
    AND column_name = 'decision_id'
    AND seq_in_index = 1
    AND non_unique = false
);
