-- 032-encrypted-oauth-tokens.sql
-- Adds envelope encryption columns to oauth_tokens.
-- Plaintext access_token and refresh_token columns are NOT dropped here.
-- They stay for the lazy-migration window: tokens are migrated to the
-- encrypted columns on first read after a user has initialised their vault.
-- A follow-up migration will drop the plaintext columns once all rows have
-- been migrated.
--
-- Crypto: AES-256-GCM with a per-row 96-bit IV.
-- Key derivation: scrypt(passphrase, per-user salt).
-- See packages/credential-vault/src/key-derivation.ts for parameters.

ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS encrypted_access_token  BYTES   NULL;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS encrypted_refresh_token BYTES   NULL;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS encryption_iv           BYTES   NULL;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS encryption_tag          BYTES   NULL;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS encryption_key_version  INT     NOT NULL DEFAULT 1;

-- Drop NOT NULL on the plaintext columns so lazy migration can clear them
-- to actual NULL rather than leaving empty-string sentinels behind.
ALTER TABLE oauth_tokens ALTER COLUMN access_token  DROP NOT NULL;
ALTER TABLE oauth_tokens ALTER COLUMN refresh_token DROP NOT NULL;

-- Vault metadata: salt and a verifier hash per user so we can
-- confirm the correct passphrase without storing it.
-- passphrase_salt  — random bytes fed to scrypt; unique per user.
-- passphrase_hash  — SHA-256 of the scrypt-derived key; used only for
--                    passphrase verification, never for decryption.

CREATE TABLE IF NOT EXISTS user_credential_vault_meta (
  user_id          UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  passphrase_salt  BYTES       NOT NULL,
  passphrase_hash  BYTES       NOT NULL,
  current_key_version INT      NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at       TIMESTAMPTZ
);
