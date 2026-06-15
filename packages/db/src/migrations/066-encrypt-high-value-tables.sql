-- 065-encrypt-high-value-tables.sql
-- Application-level envelope encryption AT REST for the three highest-value
-- tables: preferences, twin_profiles, and brain_pages.
--
-- This mirrors the column shape of migration 032-encrypted-oauth-tokens.sql.
-- The plaintext columns are NOT dropped here — they stay for the lazy-
-- migration window. Each affected column is encrypted to its sibling
-- `<col>_encrypted BYTES` on first write/read after the user's vault is
-- initialised; the plaintext column is then set to NULL. A follow-up
-- migration (separate PR, after a soak period) drops the plaintext columns.
--
-- Packed ciphertext format (see packages/db/src/lib/vault-helper.ts and the
-- DbTokenStore precedent): [IV (12 bytes)] + [tag (16 bytes)] + [ciphertext].
-- Each column is encrypted independently with its own fresh 96-bit IV. We use
-- one packed BYTES column per encrypted value rather than the legacy
-- iv/tag-as-separate-columns shape so we can encrypt N columns on a row
-- without N pairs of iv/tag columns, and so a single IV is never reused
-- across two distinct AES-256-GCM encryptions on the same row.
--
-- Crypto: AES-256-GCM. Key derivation: scrypt(passphrase, per-user salt).
-- See packages/credential-vault/src/key-derivation.ts for parameters.
-- Master key derives from the existing credential-vault passphrase mechanism.
-- OS-keychain integration is tracked as the follow-up in #401.

-- ── preferences ─────────────────────────────────────────────────────────────
-- Sensitive columns: value (the learned preference), evidence (supporting ids/notes).
ALTER TABLE preferences ADD COLUMN IF NOT EXISTS value_encrypted        BYTES NULL;
ALTER TABLE preferences ADD COLUMN IF NOT EXISTS evidence_encrypted     BYTES NULL;
ALTER TABLE preferences ADD COLUMN IF NOT EXISTS encryption_key_version INT NOT NULL DEFAULT 1;
ALTER TABLE preferences ALTER COLUMN value DROP NOT NULL;
ALTER TABLE preferences ALTER COLUMN evidence DROP NOT NULL;

-- ── twin_profiles ─────────────────────────────────────────────────────────────
-- Seven JSONB columns hold the twin's learned model of the user.
ALTER TABLE twin_profiles ADD COLUMN IF NOT EXISTS preferences_encrypted         BYTES NULL;
ALTER TABLE twin_profiles ADD COLUMN IF NOT EXISTS inferences_encrypted          BYTES NULL;
ALTER TABLE twin_profiles ADD COLUMN IF NOT EXISTS risk_tolerance_encrypted      BYTES NULL;
ALTER TABLE twin_profiles ADD COLUMN IF NOT EXISTS spend_norms_encrypted         BYTES NULL;
ALTER TABLE twin_profiles ADD COLUMN IF NOT EXISTS communication_style_encrypted BYTES NULL;
ALTER TABLE twin_profiles ADD COLUMN IF NOT EXISTS routines_encrypted            BYTES NULL;
ALTER TABLE twin_profiles ADD COLUMN IF NOT EXISTS domain_heuristics_encrypted   BYTES NULL;
ALTER TABLE twin_profiles ADD COLUMN IF NOT EXISTS encryption_key_version        INT NOT NULL DEFAULT 1;
ALTER TABLE twin_profiles ALTER COLUMN preferences DROP NOT NULL;
ALTER TABLE twin_profiles ALTER COLUMN inferences DROP NOT NULL;
ALTER TABLE twin_profiles ALTER COLUMN risk_tolerance DROP NOT NULL;
ALTER TABLE twin_profiles ALTER COLUMN spend_norms DROP NOT NULL;
ALTER TABLE twin_profiles ALTER COLUMN communication_style DROP NOT NULL;
ALTER TABLE twin_profiles ALTER COLUMN routines DROP NOT NULL;
ALTER TABLE twin_profiles ALTER COLUMN domain_heuristics DROP NOT NULL;

-- ── brain_pages ─────────────────────────────────────────────────────────────
-- title + content + metadata carry the textual surface of the brain backend.
-- content_tsv (FTS) and embedding (vector) are intentionally left plaintext:
-- they are derived, and encrypting them would break RRF retrieval and the
-- metadata->>'authoringTier' tier-weighting SQL filters. The tokenized-leak
-- trade-off is documented in docs/privacy.md (v0.7); v0.8 revisits.
ALTER TABLE brain_pages ADD COLUMN IF NOT EXISTS title_encrypted        BYTES NULL;
ALTER TABLE brain_pages ADD COLUMN IF NOT EXISTS content_encrypted      BYTES NULL;
ALTER TABLE brain_pages ADD COLUMN IF NOT EXISTS metadata_encrypted     BYTES NULL;
ALTER TABLE brain_pages ADD COLUMN IF NOT EXISTS encryption_key_version INT NOT NULL DEFAULT 1;
ALTER TABLE brain_pages ALTER COLUMN title DROP NOT NULL;
ALTER TABLE brain_pages ALTER COLUMN content DROP NOT NULL;
ALTER TABLE brain_pages ALTER COLUMN metadata DROP NOT NULL;
