-- Durable, one-shot twin projection for canonical Gmail archive approval feedback.
--
-- This table is installation-local learner state. It is intentionally absent
-- from portable backups and from joined-receipt v1 projections. Runtime
-- activation and receipt finalization are separate slices.

SELECT 1 / 0 AS migration_093_profile_version_duplicate_preflight
WHERE EXISTS (
  SELECT profile_id, version
    FROM twin_profile_versions
   GROUP BY profile_id, version
  HAVING count(*) > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS twin_profiles_id_user_id_idx
  ON twin_profiles (id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS twin_profile_versions_profile_version_idx
  ON twin_profile_versions (profile_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS feedback_events_id_owner_decision_idx
  ON feedback_events (id, user_id, decision_id);

CREATE TABLE IF NOT EXISTS twin_feedback_applications (
  id UUID PRIMARY KEY,
  feedback_event_id UUID NOT NULL,
  user_id UUID NOT NULL,
  decision_id UUID NOT NULL,
  profile_id UUID NOT NULL,
  input_profile_version INT NOT NULL,
  output_profile_version INT NOT NULL,
  changed BOOL NOT NULL,
  output_digest STRING NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT twin_feedback_applications_feedback_unique UNIQUE (feedback_event_id),
  CONSTRAINT twin_feedback_applications_feedback_owner_decision_fk
    FOREIGN KEY (feedback_event_id, user_id, decision_id)
    REFERENCES feedback_events (id, user_id, decision_id) ON DELETE CASCADE,
  CONSTRAINT twin_feedback_applications_profile_owner_fk
    FOREIGN KEY (profile_id, user_id)
    REFERENCES twin_profiles (id, user_id),
  CONSTRAINT twin_feedback_applications_versions_chk CHECK (
    input_profile_version > 0 AND
    ((changed = true AND output_profile_version = input_profile_version + 1) OR
     (changed = false AND output_profile_version = input_profile_version))
  ),
  CONSTRAINT twin_feedback_applications_digest_chk CHECK (
    output_digest ~ '^[0-9a-f]{64}$'
  )
);
-- A partially applied or manually populated namesake must never be accepted.
-- Relationship FKs and CHECK constraints cover future writes; this preflight
-- also rejects dirty rows created before those constraints were installed.
SELECT 1 / 0 AS migration_093_application_relationship_preflight
WHERE EXISTS (
  SELECT 1
    FROM twin_feedback_applications application
    LEFT JOIN feedback_events feedback
      ON feedback.id = application.feedback_event_id
     AND feedback.user_id = application.user_id
     AND feedback.decision_id = application.decision_id
    LEFT JOIN twin_profiles profile
      ON profile.id = application.profile_id
     AND profile.user_id = application.user_id
   WHERE feedback.id IS NULL OR profile.id IS NULL
      OR application.input_profile_version <= 0
      OR ((application.changed = true AND
           application.output_profile_version <> application.input_profile_version + 1)
       OR (application.changed = false AND
           application.output_profile_version <> application.input_profile_version))
      OR application.output_digest !~ '^[0-9a-f]{64}$'
);

-- Verify IF NOT EXISTS did not accept malformed namesakes. These exact key
-- checks intentionally reject storing columns, changed order, or predicates.
SELECT 1 / 0 AS migration_093_profile_owner_index_preflight
WHERE NOT (
  (SELECT count(*) FROM [SHOW INDEXES FROM twin_profiles]
    WHERE index_name = 'twin_profiles_id_user_id_idx'
      AND non_unique = false AND storing = false AND implicit = false) = 2
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM twin_profiles]
     WHERE index_name = 'twin_profiles_id_user_id_idx' AND seq_in_index = 1
       AND column_name = 'id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM twin_profiles]
     WHERE index_name = 'twin_profiles_id_user_id_idx' AND seq_in_index = 2
       AND column_name = 'user_id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
);

SELECT 1 / 0 AS migration_093_profile_version_index_preflight
WHERE NOT (
  (SELECT count(*) FROM [SHOW INDEXES FROM twin_profile_versions]
    WHERE index_name = 'twin_profile_versions_profile_version_idx'
      AND non_unique = false AND storing = false AND implicit = false) = 2
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM twin_profile_versions]
     WHERE index_name = 'twin_profile_versions_profile_version_idx' AND seq_in_index = 1
       AND column_name = 'profile_id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM twin_profile_versions]
     WHERE index_name = 'twin_profile_versions_profile_version_idx' AND seq_in_index = 2
       AND column_name = 'version' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
);

SELECT 1 / 0 AS migration_093_feedback_identity_index_preflight
WHERE NOT (
  (SELECT count(*) FROM [SHOW INDEXES FROM feedback_events]
    WHERE index_name = 'feedback_events_id_owner_decision_idx'
      AND non_unique = false AND storing = false AND implicit = false) = 3
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM feedback_events]
     WHERE index_name = 'feedback_events_id_owner_decision_idx' AND seq_in_index = 1
       AND column_name = 'id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM feedback_events]
     WHERE index_name = 'feedback_events_id_owner_decision_idx' AND seq_in_index = 2
       AND column_name = 'user_id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM feedback_events]
     WHERE index_name = 'feedback_events_id_owner_decision_idx' AND seq_in_index = 3
       AND column_name = 'decision_id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
);

SELECT 1 / 0 AS migration_093_application_feedback_unique_preflight
WHERE NOT (
  (SELECT count(*) FROM [SHOW INDEXES FROM twin_feedback_applications]
    WHERE index_name = 'twin_feedback_applications_feedback_unique'
      AND non_unique = false AND storing = false AND implicit = false) = 1
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM twin_feedback_applications]
     WHERE index_name = 'twin_feedback_applications_feedback_unique'
       AND seq_in_index = 1 AND column_name = 'feedback_event_id'
       AND direction = 'ASC' AND non_unique = false
       AND storing = false AND implicit = false
  )
);

SELECT 1 / 0 AS migration_093_application_feedback_fk_preflight
WHERE NOT EXISTS (
  SELECT 1 FROM [SHOW CONSTRAINTS FROM twin_feedback_applications]
   WHERE constraint_name = 'twin_feedback_applications_feedback_owner_decision_fk'
     AND constraint_type = 'FOREIGN KEY' AND validated = true
     AND details =
       'FOREIGN KEY (feedback_event_id, user_id, decision_id) REFERENCES feedback_events(id, user_id, decision_id) ON DELETE CASCADE'
);

SELECT 1 / 0 AS migration_093_application_profile_fk_preflight
WHERE NOT EXISTS (
  SELECT 1 FROM [SHOW CONSTRAINTS FROM twin_feedback_applications]
   WHERE constraint_name = 'twin_feedback_applications_profile_owner_fk'
     AND constraint_type = 'FOREIGN KEY' AND validated = true
     AND details =
       'FOREIGN KEY (profile_id, user_id) REFERENCES twin_profiles(id, user_id)'
);

SELECT 1 / 0 AS migration_093_application_checks_preflight
WHERE NOT (
  EXISTS (
    SELECT 1 FROM [SHOW CONSTRAINTS FROM twin_feedback_applications]
     WHERE constraint_name = 'twin_feedback_applications_versions_chk'
       AND constraint_type = 'CHECK' AND validated = true
  )
  AND EXISTS (
    SELECT 1 FROM [SHOW CONSTRAINTS FROM twin_feedback_applications]
     WHERE constraint_name = 'twin_feedback_applications_digest_chk'
       AND constraint_type = 'CHECK' AND validated = true
  )
);
