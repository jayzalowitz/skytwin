-- Credential requirements: adapters register what credentials/integrations
-- their skills need. When OpenClaw adds a skill that needs e.g. Twitter
-- API keys, it inserts a row here. The Setup page renders these dynamically
-- and the dashboard flags unmet requirements to the user.

CREATE TABLE IF NOT EXISTS credential_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter STRING NOT NULL,
  integration STRING NOT NULL,
  integration_label STRING NOT NULL,
  description STRING,
  field_key STRING NOT NULL,
  field_label STRING NOT NULL,
  field_placeholder STRING,
  is_secret BOOLEAN NOT NULL DEFAULT false,
  is_optional BOOLEAN NOT NULL DEFAULT false,
  skills STRING[] NOT NULL DEFAULT ARRAY[]::STRING[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (adapter, integration, field_key)
);

CREATE INDEX idx_credential_requirements_adapter ON credential_requirements (adapter);
CREATE INDEX idx_credential_requirements_integration ON credential_requirements (integration);
