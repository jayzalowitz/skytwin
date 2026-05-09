-- 037-federation-peers.sql
-- Federation between a single user's instances (#194 Child 1).
--
-- Two SkyTwin instances belonging to the same person (e.g. desktop +
-- phone) pair via NaCl box: instance A generates a keypair + 6-digit
-- pairing code; instance B enters the code and posts its public key;
-- A confirms (matching code), at which point both sides persist the
-- peer's public key.
--
-- Once paired, a worker job exchanges sync deltas (installed servers,
-- earned trust tiers, dismissed suggestions, recipes installed, risk
-- profile, capability provenance edges) every hour. OAuth tokens are
-- excluded — those stay per-instance for security.

CREATE TABLE IF NOT EXISTS federation_peers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Friendly label set by the user at pairing time, e.g. "Office laptop".
  label STRING NOT NULL,
  -- The peer's NaCl box public key (32 bytes, base64-encoded for portability).
  peer_public_key STRING NOT NULL,
  -- Our side of the keypair (32-byte private + 32-byte public, base64).
  -- These are NEVER returned over the wire — only the public part flows.
  -- Stored separately so we don't roll a fresh keypair on every sync.
  local_secret_key STRING NOT NULL,
  local_public_key STRING NOT NULL,
  -- Optional human-meaningful endpoint (e.g. "https://laptop.local:3001").
  -- Used by the sync job; null means "passive peer", we don't push to it.
  endpoint_url STRING,
  paired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at TIMESTAMPTZ,
  last_sync_status STRING,        -- 'ok' | 'failed' | 'never' | 'paused'
  last_sync_error STRING,
  unpaired_at TIMESTAMPTZ,         -- soft-delete; rows survive for audit
  UNIQUE (user_id, peer_public_key)
);

CREATE INDEX IF NOT EXISTS federation_peers_user_active_idx
  ON federation_peers (user_id, paired_at DESC)
  WHERE unpaired_at IS NULL;

-- Pairing-in-progress slots. Created by POST /api/federation/pair/start;
-- consumed (deleted) by POST /api/federation/pair/complete. Slots expire
-- after 10 minutes — the table is small and pairing is rare, so a
-- periodic sweep is fine; we don't need a TTL extension.
CREATE TABLE IF NOT EXISTS federation_pairing_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pairing_code STRING NOT NULL,    -- 6-digit numeric code shown to user
  -- Our side of the keypair generated at pair-start. The peer signs
  -- with our public key; we open with the secret. Discarded on
  -- completion — the persisted peer row gets fresh keys.
  local_secret_key STRING NOT NULL,
  local_public_key STRING NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_pairing_codes_user_active_idx
  ON federation_pairing_codes (user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS federation_pairing_codes_code_idx
  ON federation_pairing_codes (pairing_code, expires_at);
