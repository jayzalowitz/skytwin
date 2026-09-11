-- Recovery wrappers belong in the source-of-truth database so a database
-- backup plus the user's passphrase remains recoverable. Device wrappers stay
-- outside CockroachDB and are optional accelerators, never the sole wrapper.
CREATE TABLE IF NOT EXISTS user_source_key_registry (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_version INT NOT NULL,
  wrapper_version INT NOT NULL,
  algorithm STRING NOT NULL,
  kdf_record JSONB NOT NULL,
  recovery_wrapper JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, key_version),
  CONSTRAINT source_key_positive_versions CHECK (key_version > 0 AND wrapper_version > 0),
  CONSTRAINT source_key_algorithm CHECK (algorithm = 'aes-256-gcm')
);

-- Cross-store removal will use a retryable intent: deleting the user removes
-- the registry. A future Electron consumer must use this non-secret marker to
-- erase its local device wrapper even after a crash.
CREATE TABLE IF NOT EXISTS source_key_deletion_intents (
  user_id UUID PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_wrapper_deleted_at TIMESTAMPTZ
);
