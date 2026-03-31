-- OAuth tokens and connector configuration for real integrations

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  provider STRING NOT NULL,
  access_token STRING NOT NULL,
  refresh_token STRING NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  scopes STRING[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS connector_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  provider STRING NOT NULL,
  connector_type STRING NOT NULL,
  enabled BOOL NOT NULL DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  sync_cursor STRING,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id, connector_type)
);
