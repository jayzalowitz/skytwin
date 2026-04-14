-- Cached IronClaw tool manifests discovered from the IronClaw registry.

CREATE TABLE IF NOT EXISTS ironclaw_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name STRING NOT NULL UNIQUE,
  description STRING,
  action_types STRING[] NOT NULL DEFAULT '{}',
  requires_credentials STRING[] NOT NULL DEFAULT '{}',
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ironclaw_tools_discovered ON ironclaw_tools (discovered_at DESC);
