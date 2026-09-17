-- Pin adaptive Watch projections and every durable slot to the exact immutable
-- workflow version that produced them. Legacy Watches/runs remain all-NULL:
-- migration-time attribution would be unsafe when an exact version cannot be
-- proven from historical data.

-- CockroachDB requires the referenced column tuple to be unique. Including the
-- content hash in the key makes a forged/stale hash fail at the FK boundary.
ALTER TABLE workflow_versions ADD CONSTRAINT IF NOT EXISTS
  workflow_versions_projection_pin_unique
  UNIQUE (
    id, workflow_id, user_id, provider_key, provider_schema_version, content_hash
  );

ALTER TABLE watches ADD COLUMN IF NOT EXISTS workflow_id UUID;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS workflow_version_id UUID;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS workflow_provider_key STRING;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS workflow_provider_schema_version STRING;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS content_hash STRING;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS projection_version INT;

ALTER TABLE watches ADD CONSTRAINT IF NOT EXISTS watches_workflow_pin_shape_chk
  CHECK (
    (workflow_id IS NULL AND workflow_version_id IS NULL
      AND workflow_provider_key IS NULL AND workflow_provider_schema_version IS NULL
      AND content_hash IS NULL AND projection_version IS NULL)
    OR
    (workflow_id IS NOT NULL AND workflow_version_id IS NOT NULL
      AND workflow_provider_key IS NOT NULL AND workflow_provider_schema_version IS NOT NULL
      AND content_hash IS NOT NULL AND projection_version IS NOT NULL AND projection_version > 0)
  );

ALTER TABLE watches ADD CONSTRAINT IF NOT EXISTS watches_workflow_version_owner_hash_fk
  FOREIGN KEY (
    workflow_version_id, workflow_id, user_id,
    workflow_provider_key, workflow_provider_schema_version, content_hash
  ) REFERENCES workflow_versions (
    id, workflow_id, user_id, provider_key, provider_schema_version, content_hash
  )
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS watches_workflow_projection_idx
  ON watches (workflow_id, workflow_version_id);

CREATE UNIQUE INDEX IF NOT EXISTS watches_one_projection_per_workflow_idx
  ON watches (workflow_id) WHERE workflow_id IS NOT NULL;

ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS workflow_id UUID;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS workflow_version_id UUID;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS workflow_provider_key STRING;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS workflow_provider_schema_version STRING;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS content_hash STRING;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS projection_version INT;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS workflow_payload_snapshot JSONB;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS workflow_inference_snapshot JSONB;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS evidence_sha256 STRING;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS evidence_snapshot JSONB NOT NULL DEFAULT '[]'::JSONB;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS synthesis_metadata JSONB;

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_workflow_pin_shape_chk
  CHECK (
    (workflow_id IS NULL AND workflow_version_id IS NULL
      AND workflow_provider_key IS NULL AND workflow_provider_schema_version IS NULL
      AND content_hash IS NULL AND projection_version IS NULL
      AND workflow_payload_snapshot IS NULL AND workflow_inference_snapshot IS NULL)
    OR
    (workflow_id IS NOT NULL AND workflow_version_id IS NOT NULL
      AND workflow_provider_key IS NOT NULL AND workflow_provider_schema_version IS NOT NULL
      AND content_hash IS NOT NULL AND projection_version IS NOT NULL AND projection_version > 0
      AND workflow_payload_snapshot IS NOT NULL)
  );

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_evidence_sha256_chk
  CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_evidence_snapshot_shape_chk
  CHECK (jsonb_typeof(evidence_snapshot) = 'array');
ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_synthesis_metadata_shape_chk
  CHECK (synthesis_metadata IS NULL OR jsonb_typeof(synthesis_metadata) = 'object');
ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_workflow_inference_shape_chk
  CHECK (workflow_inference_snapshot IS NULL OR jsonb_typeof(workflow_inference_snapshot) = 'object');

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_workflow_version_owner_hash_fk
  FOREIGN KEY (
    workflow_version_id, workflow_id, user_id,
    workflow_provider_key, workflow_provider_schema_version, content_hash
  ) REFERENCES workflow_versions (
    id, workflow_id, user_id, provider_key, provider_schema_version, content_hash
  )
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS watch_runs_workflow_version_idx
  ON watch_runs (workflow_id, workflow_version_id, scheduled_for);
