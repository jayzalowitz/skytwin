-- Durable, idempotent feedback intent for the dedicated Gmail archive approval.
--
-- The nullable column preserves every historical/generic feedback row. Dedicated
-- approval responses set it and are thereby bound by the database to the exact
-- approval owner and decision. Source feedback remains installation-local and
-- intentionally absent from portable backups; receipt v1 digests continue to
-- project the original feedback fields only.

ALTER TABLE feedback_events
  ADD COLUMN IF NOT EXISTS approval_request_id UUID;

-- An approval must itself belong to the owner of its decision. The historical
-- single-column FK proves only that the decision exists, so fail closed rather
-- than silently relabelling any cross-owner approval.
SELECT 1 / 0 AS migration_092_approval_owner_preflight
WHERE EXISTS (
  SELECT 1
    FROM approval_requests approval
    LEFT JOIN decisions decision
      ON decision.id = approval.decision_id
     AND decision.user_id = approval.user_id
   WHERE decision.id IS NULL
);

-- Do not silently repair or discard dirty feedback state on a partially
-- applied/retried deployment. A portable division-by-zero makes the migration
-- fail loudly before installing constraints if a populated link is missing or
-- disagrees with its approval's owner/decision.
SELECT 1 / 0 AS migration_092_feedback_relationship_preflight
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

-- The two referenced tuples make the complete owner/decision/approval graph a
-- database invariant rather than a repository convention. Migration 081 owns
-- decisions_id_user_id_idx; verify and reuse it instead of adding an equivalent
-- index under a second name.
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_id_owner_decision_idx
  ON approval_requests (id, user_id, decision_id);

CREATE UNIQUE INDEX IF NOT EXISTS feedback_events_approval_request_unique_idx
  ON feedback_events (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

ALTER TABLE approval_requests
  ADD CONSTRAINT IF NOT EXISTS approval_requests_decision_owner_fk
  FOREIGN KEY (decision_id, user_id)
  REFERENCES decisions (id, user_id);

ALTER TABLE feedback_events
  ADD CONSTRAINT IF NOT EXISTS feedback_events_approval_owner_decision_fk
  FOREIGN KEY (approval_request_id, user_id, decision_id)
  REFERENCES approval_requests (id, user_id, decision_id)
  ON DELETE CASCADE;

-- Assert exact non-storing key sequences, uniqueness, and predicates rather
-- than accepting a stale same-named object that IF NOT EXISTS skipped.
SELECT 1 / 0 AS migration_092_decision_owner_index_preflight
WHERE NOT (
  (SELECT count(*) FROM [SHOW INDEXES FROM decisions]
    WHERE index_name = 'decisions_id_user_id_idx'
      AND non_unique = false AND storing = false AND implicit = false) = 2
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM decisions]
     WHERE index_name = 'decisions_id_user_id_idx' AND seq_in_index = 1
       AND column_name = 'id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM decisions]
     WHERE index_name = 'decisions_id_user_id_idx' AND seq_in_index = 2
       AND column_name = 'user_id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index index_metadata
      JOIN pg_catalog.pg_class index_class ON index_class.oid = index_metadata.indexrelid
      JOIN pg_catalog.pg_class table_class ON table_class.oid = index_metadata.indrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE index_class.relname = 'decisions_id_user_id_idx'
       AND table_class.relname = 'decisions'
       AND namespace.nspname = current_schema()
       AND index_metadata.indisunique = true
       AND index_metadata.indnkeyatts = 2
       AND index_metadata.indpred IS NULL
  )
);

SELECT 1 / 0 AS migration_092_approval_tuple_index_preflight
WHERE NOT (
  (SELECT count(*) FROM [SHOW INDEXES FROM approval_requests]
    WHERE index_name = 'approval_requests_id_owner_decision_idx'
      AND non_unique = false AND storing = false AND implicit = false) = 3
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM approval_requests]
     WHERE index_name = 'approval_requests_id_owner_decision_idx' AND seq_in_index = 1
       AND column_name = 'id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM approval_requests]
     WHERE index_name = 'approval_requests_id_owner_decision_idx' AND seq_in_index = 2
       AND column_name = 'user_id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM approval_requests]
     WHERE index_name = 'approval_requests_id_owner_decision_idx' AND seq_in_index = 3
       AND column_name = 'decision_id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index index_metadata
      JOIN pg_catalog.pg_class index_class ON index_class.oid = index_metadata.indexrelid
      JOIN pg_catalog.pg_class table_class ON table_class.oid = index_metadata.indrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE index_class.relname = 'approval_requests_id_owner_decision_idx'
       AND table_class.relname = 'approval_requests'
       AND namespace.nspname = current_schema()
       AND index_metadata.indisunique = true
       AND index_metadata.indnkeyatts = 3
       AND index_metadata.indpred IS NULL
  )
);

SELECT 1 / 0 AS migration_092_feedback_unique_index_preflight
WHERE NOT (
  (SELECT count(*) FROM [SHOW INDEXES FROM feedback_events]
    WHERE index_name = 'feedback_events_approval_request_unique_idx'
      AND non_unique = false AND storing = false AND implicit = false) = 1
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM feedback_events]
     WHERE index_name = 'feedback_events_approval_request_unique_idx' AND seq_in_index = 1
       AND column_name = 'approval_request_id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index index_metadata
      JOIN pg_catalog.pg_class index_class ON index_class.oid = index_metadata.indexrelid
      JOIN pg_catalog.pg_class table_class ON table_class.oid = index_metadata.indrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE index_class.relname = 'feedback_events_approval_request_unique_idx'
       AND table_class.relname = 'feedback_events'
       AND namespace.nspname = current_schema()
       AND index_metadata.indisunique = true
       AND index_metadata.indnkeyatts = 1
       AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid) =
         'approval_request_id IS NOT NULL'
  )
);

-- IF NOT EXISTS must never turn a malformed namesake into a successful
-- migration. Verify the exact foreign-key shapes after every startup rerun.
SELECT 1 / 0 AS migration_092_approval_owner_fk_preflight
WHERE NOT EXISTS (
  SELECT 1 FROM [SHOW CONSTRAINTS FROM approval_requests]
   WHERE constraint_name = 'approval_requests_decision_owner_fk'
     AND constraint_type = 'FOREIGN KEY'
     AND details =
       'FOREIGN KEY (decision_id, user_id) REFERENCES decisions(id, user_id)'
     AND validated = true
);
SELECT 1 / 0 AS migration_092_feedback_relationship_fk_preflight
WHERE NOT EXISTS (
  SELECT 1 FROM [SHOW CONSTRAINTS FROM feedback_events]
   WHERE constraint_name = 'feedback_events_approval_owner_decision_fk'
     AND constraint_type = 'FOREIGN KEY'
     AND details =
       'FOREIGN KEY (approval_request_id, user_id, decision_id) REFERENCES approval_requests(id, user_id, decision_id) ON DELETE CASCADE'
     AND validated = true
);
