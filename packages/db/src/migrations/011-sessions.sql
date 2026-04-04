-- Session tokens for mobile QR pairing
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash STRING NOT NULL,
  device_name STRING DEFAULT 'Phone',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash) WHERE revoked = false;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id) WHERE revoked = false;
