-- 059-oauth-pending-signin.sql
-- Pollable pending-completion row for desktop new-user OAuth flows.
--
-- Why it exists. The web sign-in flow advances through a browser
-- redirect: /authorize → Google → /callback → res.redirect into the
-- dashboard with `?userId=…` in the URL. Done in one trip.
--
-- The desktop flow is different. SkyTwin opens the OAuth URL in the
-- user's *system* browser (Google blocks WebView for passkey/WebAuthn
-- reasons), the callback fires there, and the user must manually
-- close the browser tab to return to the Electron app. Without a way
-- to bridge that gap, the wizard sits on "Continue with Google" with
-- no advance signal — a real grandma-blocker.
--
-- For existing users the desktop client already polls
-- /api/oauth/google/status?userId=… every 2s for five minutes. That
-- works because the userId is known in advance. For a brand-new user
-- there's no userId until after /callback runs and creates the row.
--
-- This table is the per-flow handoff: the client generates a
-- 128-bit pendingKey before opening the OAuth URL, threads it through
-- the HMAC-signed state, /callback writes the resulting userId here,
-- and the desktop wizard polls `GET /api/oauth/google/pending/:key`
-- (DELETE...RETURNING — consume-on-read) until the row appears.
--
-- Schema notes.
--   pending_key   Client-generated random opaque token (crypto.randomUUID
--                 in v4 form). Server validates the UUIDv4 shape before
--                 trusting it. NOT a credential — the key is unguessable
--                 by an attacker, and the worst case if leaked is a 5-min
--                 window in which someone could learn that <email> just
--                 finished signing in.
--   user_id       The user we just created or matched on /callback.
--   account_email Verified Google email (also persisted in oauth_tokens;
--                 redundant for fast read on the poll endpoint).
--   scopes        Granted scope list — lets the desktop client decide
--                 (e.g. "are Gmail scopes present? skip the wizard").
--   next_hash     The whitelisted post-callback deep-link target the
--                 wizard should land on (e.g. '#/connect-gmail'). Null
--                 = wizard's default landing decision applies.
--   expires_at    5-minute TTL. Far longer than any legitimate poll
--                 needs; sweeps clear expired rows on every insert.
CREATE TABLE IF NOT EXISTS oauth_pending_signin (
    pending_key   TEXT PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_email TEXT NOT NULL,
    scopes        JSONB NOT NULL DEFAULT '[]'::jsonb,
    next_hash     TEXT,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_pending_signin_expires_at_idx
    ON oauth_pending_signin (expires_at);
