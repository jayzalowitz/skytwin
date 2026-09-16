-- Account-bound Gmail evidence foundation (#658).
--
-- This migration deliberately stores only stable identifiers and observation
-- metadata. OAuth secrets remain in oauth_tokens and Gmail content remains in
-- the existing signal payload; gmail_message_refs never stores a body,
-- credential, or provider response.

ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS provider_subject_digest STRING;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS account_display STRING;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS identity_verified BOOL NOT NULL DEFAULT false;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE connected_accounts ADD CONSTRAINT connected_accounts_verified_subject_chk
  CHECK (
    identity_verified = false OR (
      provider_subject_digest IS NOT NULL
      AND provider_subject_digest ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_subject_key
  ON connected_accounts (user_id, provider, provider_subject_digest)
  WHERE provider_subject_digest IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_id_user_provider_key
  ON connected_accounts (id, user_id, provider);
CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_id_user_key
  ON connected_accounts (id, user_id);

ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS connector_account_id UUID;
-- Exact compare-and-swap token. TIMESTAMPTZ cannot safely serve as a version:
-- node-postgres truncates CockroachDB's sub-millisecond precision.
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS credential_revision UUID NOT NULL DEFAULT gen_random_uuid();

-- Existing token rows predate a trusted connected_accounts writer. Give each
-- one an opaque, stable identity without pretending its legacy email/provider
-- fields are a verified provider subject. A later OAuth callback can create a
-- verified identity; no Gmail mutation may rely on an unverified legacy row.
INSERT INTO connected_accounts (
  id, user_id, provider, account_id, scopes, is_active, connected_at,
  account_display, identity_verified, updated_at
)
SELECT
  t.id, t.user_id, t.provider, 'legacy:' || t.id::STRING, t.scopes, true,
  t.created_at, NULLIF(t.account_email, ''), false, t.updated_at
FROM oauth_tokens AS t
WHERE t.connector_account_id IS NULL
ON CONFLICT (id) DO NOTHING;

UPDATE oauth_tokens
   SET connector_account_id = id
 WHERE connector_account_id IS NULL;

-- Legacy identities are deliberately ineligible for trusted polling until a
-- fresh provider callback proves the stable subject. Surface that pause via
-- the existing connector status API instead of silently dropping the poller.
INSERT INTO connector_health (
  user_id, connector_name, status, error_code, last_failure_at, updated_at
)
SELECT
  ca.user_id,
  CASE ca.provider
    WHEN 'google' THEN 'gmail:'
    WHEN 'microsoft' THEN 'outlook_mail:'
    ELSE ca.provider || ':'
  END || ca.id::STRING,
  'needs_reauth',
  'identity_verification_required', now(), now()
FROM connected_accounts AS ca
WHERE ca.provider IN ('google', 'microsoft')
  AND ca.identity_verified = false AND ca.is_active = true
ON CONFLICT (user_id, connector_name) DO UPDATE SET
  status = 'needs_reauth',
  error_code = 'identity_verification_required',
  last_failure_at = now(),
  updated_at = now();

CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_connector_account_key
  ON oauth_tokens (connector_account_id)
  WHERE connector_account_id IS NOT NULL;

ALTER TABLE oauth_tokens
  ADD CONSTRAINT oauth_tokens_connector_account_fk
  FOREIGN KEY (connector_account_id, user_id, provider)
  REFERENCES connected_accounts (id, user_id, provider) ON DELETE CASCADE;

ALTER TABLE oauth_tokens ALTER COLUMN connector_account_id SET NOT NULL;

-- Replace the legacy natural primary key with a surrogate id. Partial unique
-- indexes preserve the legacy unbound cursor contract for Calendar/Outlook
-- while allowing one Gmail history cursor per connected account.
-- CockroachDB rejects even ADD COLUMN IF NOT EXISTS on a locked table, so the
-- first narrow window also makes startup reruns safe.
ALTER TABLE connector_cursors SET (schema_locked = false);
ALTER TABLE connector_cursors ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
ALTER TABLE connector_cursors ADD COLUMN IF NOT EXISTS connector_account_id UUID;
ALTER TABLE connector_cursors SET (schema_locked = true);

-- Before account binding the worker selected Google credentials with
-- ORDER BY updated_at DESC LIMIT 1. Preserve each legacy Gmail cursor for
-- exactly that deterministically selected account (id breaks timestamp ties),
-- including multi-account users; other accounts were never polled and may
-- bootstrap normally. Other provider cursors move only when unambiguous.
UPDATE connector_cursors AS c
   SET connector_account_id = (
     SELECT t.connector_account_id
       FROM oauth_tokens AS t
       JOIN connected_accounts AS ca ON ca.id = t.connector_account_id
      WHERE t.user_id = c.user_id
        AND t.provider = 'google'
        AND ca.is_active = true
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT 1
   )
 WHERE c.connector_account_id IS NULL AND c.provider = 'gmail'
   AND EXISTS (
     SELECT 1 FROM oauth_tokens AS t
      WHERE t.user_id = c.user_id AND t.provider = 'google'
   );

UPDATE connector_cursors AS c
   SET connector_account_id = (
     SELECT t.connector_account_id
      FROM oauth_tokens AS t
      JOIN connected_accounts AS ca ON ca.id = t.connector_account_id
      WHERE t.user_id = c.user_id AND t.provider = CASE c.provider
        WHEN 'google_calendar' THEN 'google'
        WHEN 'outlook' THEN 'microsoft'
        WHEN 'outlook_calendar' THEN 'microsoft'
        ELSE c.provider
      END
        AND ca.is_active = true
      LIMIT 1
   )
 WHERE c.connector_account_id IS NULL AND c.provider <> 'gmail'
   AND 1 = (
     SELECT count(*)
       FROM oauth_tokens AS t
      JOIN connected_accounts AS ca ON ca.id = t.connector_account_id
      WHERE t.user_id = c.user_id
        AND t.provider = CASE c.provider
          WHEN 'google_calendar' THEN 'google'
          WHEN 'outlook' THEN 'microsoft'
          WHEN 'outlook_calendar' THEN 'microsoft'
          ELSE c.provider
        END
        AND ca.is_active = true
   );

-- Cockroach requires the old PK drop and replacement to share one schema
-- transaction; separate runner statements hit unimplemented issue #48026.
-- Keep schema_locked disabled only for each contiguous schema-change window.
-- CockroachDB v23.2 also enforces the lock for CREATE INDEX and ADD
-- CONSTRAINT, so re-lock only after every required cursor schema mutation.
ALTER TABLE connector_cursors SET (schema_locked = false);
ALTER TABLE connector_cursors ALTER COLUMN id SET NOT NULL;
ALTER TABLE connector_cursors
  DROP CONSTRAINT IF EXISTS connector_cursors_pkey,
  ADD CONSTRAINT connector_cursors_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX IF NOT EXISTS connector_cursors_legacy_key
  ON connector_cursors (user_id, provider, cursor_kind)
  WHERE connector_account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS connector_cursors_account_kind_key
  ON connector_cursors (connector_account_id, provider, cursor_kind)
  WHERE connector_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS connector_cursors_id_user_provider_key
  ON connector_cursors (id, user_id, provider);

ALTER TABLE connector_cursors
  ADD CONSTRAINT connector_cursors_account_fk
  FOREIGN KEY (connector_account_id, user_id)
  REFERENCES connected_accounts (id, user_id) ON DELETE CASCADE;
ALTER TABLE connector_cursors SET (schema_locked = true);
CREATE TABLE IF NOT EXISTS gmail_message_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_account_id UUID NOT NULL,
  provider STRING NOT NULL DEFAULT 'google',
  provider_message_id STRING NOT NULL,
  provider_thread_id STRING,
  source_signal_id STRING NOT NULL,
  authoring_tier STRING NOT NULL,
  last_observed_inbox BOOL NOT NULL,
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gmail_message_refs_account_fk
    FOREIGN KEY (connector_account_id, user_id, provider)
    REFERENCES connected_accounts (id, user_id, provider) ON DELETE CASCADE,
  CONSTRAINT gmail_message_refs_provider_chk CHECK (provider = 'google'),
  CONSTRAINT gmail_message_refs_message_id_chk
    CHECK (length(provider_message_id) BETWEEN 1 AND 1024),
  CONSTRAINT gmail_message_refs_thread_id_chk
    CHECK (provider_thread_id IS NULL OR length(provider_thread_id) BETWEEN 1 AND 1024),
  CONSTRAINT gmail_message_refs_source_id_chk
    CHECK (length(source_signal_id) BETWEEN 1 AND 2048),
  CONSTRAINT gmail_message_refs_authoring_tier_chk CHECK (authoring_tier IN (
    'user_sent_originated', 'user_sent_reply', 'inbox_personal',
    'inbox_broadcast', 'inbox_newsletter', 'inbox_automated'
  )),
  CONSTRAINT gmail_message_refs_observation_order_chk
    CHECK (first_observed_at <= last_observed_at),
  UNIQUE (connector_account_id, provider_message_id),
  UNIQUE (connector_account_id, source_signal_id),
  UNIQUE (id, user_id, connector_account_id)
);

ALTER TABLE signals ADD COLUMN IF NOT EXISTS source_signal_id STRING;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS connector_account_id UUID;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS resource_ref_id UUID;
ALTER TABLE signals ADD CONSTRAINT signals_source_signal_id_chk
  CHECK (source_signal_id IS NULL OR length(source_signal_id) BETWEEN 1 AND 2048);

CREATE UNIQUE INDEX IF NOT EXISTS signals_owned_source_key
  ON signals (user_id, source, connector_account_id, source_signal_id)
  WHERE source_signal_id IS NOT NULL AND connector_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS signals_resource_ref_idx
  ON signals (resource_ref_id)
  WHERE resource_ref_id IS NOT NULL;

ALTER TABLE signals
  ADD CONSTRAINT signals_gmail_resource_owner_fk
  FOREIGN KEY (resource_ref_id, user_id, connector_account_id)
  REFERENCES gmail_message_refs (id, user_id, connector_account_id) ON DELETE CASCADE;
