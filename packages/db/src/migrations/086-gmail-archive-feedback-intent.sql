-- Durable, idempotent feedback intent for the dedicated Gmail archive approval.
--
-- The nullable column preserves every historical/generic feedback row. Dedicated
-- approval responses set it and are thereby bound by the database to the exact
-- approval owner and decision. Source feedback remains installation-local and
-- intentionally absent from portable backups; receipt v1 digests continue to
-- project the original feedback fields only.

ALTER TABLE feedback_events
  ADD COLUMN IF NOT EXISTS approval_request_id UUID;

-- Do not silently repair or discard dirty state on a partially applied/retried
-- deployment. A portable division-by-zero makes the migration fail loudly
-- before installing constraints if a populated link is missing or disagrees
-- with its approval's owner/decision.
SELECT 1 / 0 AS migration_086_feedback_relationship_preflight
WHERE EXISTS (
  SELECT 1
    FROM feedback_events feedback
    LEFT JOIN approval_requests approval
      ON approval.id = feedback.approval_request_id
   WHERE feedback.approval_request_id IS NOT NULL
     AND (
       approval.id IS NULL OR
       approval.user_id <> feedback.user_id OR
       approval.decision_id <> feedback.decision_id
     )
);

-- The referenced tuple makes one FK prove all three identities together.
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_id_owner_decision_idx
  ON approval_requests (id, user_id, decision_id);

CREATE UNIQUE INDEX IF NOT EXISTS feedback_events_approval_request_unique_idx
  ON feedback_events (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

ALTER TABLE feedback_events
  DROP CONSTRAINT IF EXISTS feedback_events_approval_owner_decision_fk;

ALTER TABLE feedback_events
  ADD CONSTRAINT feedback_events_approval_owner_decision_fk
  FOREIGN KEY (approval_request_id, user_id, decision_id)
  REFERENCES approval_requests (id, user_id, decision_id)
  ON DELETE CASCADE;

-- Assert that both indexes have the intended uniqueness rather than accepting
-- a stale same-named object that CREATE ... IF NOT EXISTS skipped.
SELECT 1 / 0 AS migration_086_approval_tuple_index_preflight
WHERE NOT EXISTS (
  SELECT 1 FROM [SHOW INDEXES FROM approval_requests]
   WHERE index_name = 'approval_requests_id_owner_decision_idx'
     AND column_name = 'id' AND seq_in_index = 1 AND non_unique = false
);

SELECT 1 / 0 AS migration_086_feedback_unique_index_preflight
WHERE NOT EXISTS (
  SELECT 1 FROM [SHOW INDEXES FROM feedback_events]
   WHERE index_name = 'feedback_events_approval_request_unique_idx'
     AND column_name = 'approval_request_id' AND seq_in_index = 1 AND non_unique = false
);
