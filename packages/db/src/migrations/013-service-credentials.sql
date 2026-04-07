-- Service credentials: stores API keys, secrets, and configuration
-- for external services (Google, IronClaw, OpenClaw, etc.) so that
-- non-technical users can configure them via the web UI instead of
-- editing environment variables.

CREATE TABLE IF NOT EXISTS service_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service STRING NOT NULL,
  credential_key STRING NOT NULL,
  credential_value STRING NOT NULL,
  label STRING,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service, credential_key)
);

CREATE INDEX idx_service_credentials_service ON service_credentials (service);
