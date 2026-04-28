-- 021-oauth-multi-account.sql
-- Allow multiple Google (or other-provider) accounts per user.
--
-- Before: oauth_tokens UNIQUE (user_id, provider) — one inbox per user.
-- After:  UNIQUE (user_id, provider, account_email) — N accounts per user,
--         each keyed on the verified email reported by the provider's userinfo
--         endpoint. account_provider_id holds the provider's stable id (e.g.
--         Google's `sub` claim) so a future email change doesn't break the row.
--
-- Backfill maps the single existing row per (user, provider) to that user's
-- email, which is how the seeded dev data was wired before.

ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS account_email STRING NOT NULL DEFAULT '';
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS account_provider_id STRING;

-- Backfill: map existing rows to the user's email.
UPDATE oauth_tokens
   SET account_email = (SELECT email FROM users WHERE users.id = oauth_tokens.user_id)
 WHERE account_email = '';

-- Replace the old unique key with one that includes account_email.
DROP INDEX IF EXISTS oauth_tokens_user_id_provider_key CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_user_provider_account_key
    ON oauth_tokens (user_id, provider, account_email);

-- Useful for the worker's listAllConnections() iteration.
CREATE INDEX IF NOT EXISTS oauth_tokens_provider_account_idx
    ON oauth_tokens (provider, account_email);
