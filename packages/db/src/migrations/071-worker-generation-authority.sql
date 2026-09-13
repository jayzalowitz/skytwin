CREATE TABLE IF NOT EXISTS worker_generation_authority (
  id UUID PRIMARY KEY,
  secret_hash STRING NOT NULL,
  active BOOL NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_worker_generation_authority_active
  ON worker_generation_authority (active, created_at DESC);
