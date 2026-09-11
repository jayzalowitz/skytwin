-- Establish the ownership prerequisite for installation-protected fields and
-- remove source-bearing payloads from the process-global worker dead letter
-- queue. This migration does not encrypt fields and must not be used as
-- evidence for an at-rest encryption claim.

CREATE TABLE IF NOT EXISTS installation_identity (
  singleton BOOL PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO installation_identity (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE service_credentials
  ADD COLUMN IF NOT EXISTS installation_id UUID;

UPDATE service_credentials
   SET installation_id = owner.installation_id
  FROM installation_identity AS owner
 WHERE owner.singleton = true
   AND service_credentials.installation_id IS NULL;

ALTER TABLE service_credentials
  ALTER COLUMN installation_id SET NOT NULL;

ALTER TABLE service_credentials
  ADD CONSTRAINT service_credentials_installation_fk
  FOREIGN KEY (installation_id)
  REFERENCES installation_identity (installation_id)
  ON DELETE CASCADE;

-- Cockroach represents UNIQUE constraints as indexes and does not implement
-- ALTER TABLE ... DROP CONSTRAINT for them.
DROP INDEX IF EXISTS
  service_credentials@service_credentials_service_credential_key_key CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS service_credentials_installation_key_uq
  ON service_credentials (installation_id, service, credential_key);

DROP INDEX IF EXISTS service_credentials@idx_service_credentials_service;

CREATE INDEX IF NOT EXISTS idx_service_credentials_service
  ON service_credentials (installation_id, service);

ALTER TABLE credential_requirements
  ADD COLUMN IF NOT EXISTS installation_id UUID;

UPDATE credential_requirements
   SET installation_id = owner.installation_id
  FROM installation_identity AS owner
 WHERE owner.singleton = true
   AND credential_requirements.installation_id IS NULL;

ALTER TABLE credential_requirements
  ALTER COLUMN installation_id SET NOT NULL;

ALTER TABLE credential_requirements
  ADD CONSTRAINT credential_requirements_installation_fk
  FOREIGN KEY (installation_id)
  REFERENCES installation_identity (installation_id)
  ON DELETE CASCADE;

DROP INDEX IF EXISTS
  credential_requirements@credential_requirements_adapter_integration_field_key_key CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS credential_requirements_installation_key_uq
  ON credential_requirements (installation_id, adapter, integration, field_key);

DROP INDEX IF EXISTS credential_requirements@idx_credential_requirements_adapter;

DROP INDEX IF EXISTS credential_requirements@idx_credential_requirements_integration;

CREATE INDEX IF NOT EXISTS idx_credential_requirements_adapter
  ON credential_requirements (installation_id, adapter);

CREATE INDEX IF NOT EXISTS idx_credential_requirements_integration
  ON credential_requirements (installation_id, integration);

ALTER TABLE ironclaw_tools
  ADD COLUMN IF NOT EXISTS installation_id UUID;

UPDATE ironclaw_tools
   SET installation_id = owner.installation_id
  FROM installation_identity AS owner
 WHERE owner.singleton = true
   AND ironclaw_tools.installation_id IS NULL;

ALTER TABLE ironclaw_tools
  ALTER COLUMN installation_id SET NOT NULL;

ALTER TABLE ironclaw_tools
  ADD CONSTRAINT ironclaw_tools_installation_fk
  FOREIGN KEY (installation_id)
  REFERENCES installation_identity (installation_id)
  ON DELETE CASCADE;

DROP INDEX IF EXISTS ironclaw_tools@ironclaw_tools_tool_name_key CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS ironclaw_tools_installation_name_uq
  ON ironclaw_tools (installation_id, tool_name);

DROP INDEX IF EXISTS ironclaw_tools@idx_ironclaw_tools_discovered;

CREATE INDEX IF NOT EXISTS idx_ironclaw_tools_discovered
  ON ironclaw_tools (installation_id, discovered_at DESC);

-- Existing raw errors and job contexts may contain user-derived text. Do not
-- attempt to classify or preserve them: introduce a stable redaction marker,
-- then remove both source-bearing columns. Replay is cadence-driven and reads
-- current source-of-truth state, so no payload relocation is required.
ALTER TABLE worker_dead_letter
  ADD COLUMN IF NOT EXISTS error_code STRING NOT NULL DEFAULT 'legacy_redacted'
  CHECK (error_code IN (
    'broker_unavailable',
    'configuration_invalid',
    'database_unavailable',
    'job_failed',
    'legacy_redacted',
    'network_unavailable',
    'rate_limited',
    'timeout',
    'vault_locked'
  ));

-- Legacy builds only wrote hard-coded operational names, but normalize any
-- unexpected value before constraining the column so an upgrade cannot retain
-- a user-derived identifier-shaped string.
UPDATE worker_dead_letter
   SET job_name = 'unknown-job'
 WHERE job_name NOT IN (
   'briefing-generator-daily',
   'briefing-generator-weekly',
   'capability-inference',
   'changelog-poll',
   'domain-extraction',
   'embedding-backfill',
   'federation-sync',
   'memory-action-loop',
   'metrics-rollup',
   'promotion-eligibility-check',
   'relationship-tier-backfill',
   'tier-backfill',
   'unknown-job',
   'watch-scheduler'
 );

ALTER TABLE worker_dead_letter
  ADD CONSTRAINT worker_dead_letter_job_code_check
  CHECK (job_name IN (
    'briefing-generator-daily',
    'briefing-generator-weekly',
    'capability-inference',
    'changelog-poll',
    'domain-extraction',
    'embedding-backfill',
    'federation-sync',
    'memory-action-loop',
    'metrics-rollup',
    'promotion-eligibility-check',
    'relationship-tier-backfill',
    'tier-backfill',
    'unknown-job',
    'watch-scheduler'
  ));

ALTER TABLE worker_dead_letter
  DROP COLUMN IF EXISTS error_message;

ALTER TABLE worker_dead_letter
  DROP COLUMN IF EXISTS context;
