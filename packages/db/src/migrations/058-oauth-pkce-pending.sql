-- 058-oauth-pkce-pending.sql
-- Backing table for the PKCE code-verifier server-side store used by
-- /api/oauth/google/authorize → /callback. Moves the store off the
-- in-process Map in apps/api/src/routes/oauth.ts so a desktop restart
-- (Electron quit + relaunch, dev hot-reload, deploy) doesn't lose
-- in-flight verifiers and bounce the user back to "OAuth verifier
-- expired" mid sign-in.
--
-- Schema notes.
--   state         The full HMAC-signed state token returned by
--                 signStatePayload(...). It's already URL-safe and
--                 unique-by-construction, so it's the PK directly.
--                 We don't hash it: the verifier alongside it is the
--                 secret, and we want fast row-lookup by exact match.
--   code_verifier The PKCE verifier (RFC 7636) — 43+ base64url chars.
--                 Never leaves the server; never travels through Google
--                 or the user's browser. Read once on /callback and the
--                 row is deleted (consume-on-read).
--   expires_at    Hard TTL. The OAuth round-trip is minutes; verifiers
--                 older than the state's TTL are abandoned tabs we sweep
--                 on every insert.
--
-- The (expires_at) index keeps the sweep cheap even if a build burst
-- abandons many flows at once.
CREATE TABLE IF NOT EXISTS oauth_pkce_pending (
    state         TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_pkce_pending_expires_at_idx
    ON oauth_pkce_pending (expires_at);
