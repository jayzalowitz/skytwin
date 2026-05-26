-- 060-connector-health.sql
-- Backing table for the OAuth re-auth user-facing surface (#377).
--
-- When the worker refreshes a Google access token and Google returns
-- 400 invalid_grant (typically: user revoked SkyTwin's access from
-- their Google account, or the refresh token aged out of Google's
-- inactivity window), the OAuth layer correctly classifies the
-- failure as `permanent` and the per-user circuit breaker trips so
-- the worker stops hammering Google's token endpoint. Pre-fix, that
-- was the ONLY signal — the dashboard kept rendering "Listening" and
-- the user only noticed days later when "did you get my email?"
-- surfaced the silent breakage.
--
-- This table is the single piece of state the API can read to render
-- a "Gmail disconnected — Reconnect" banner. One row per
-- (user_id, connector_name). Worker upserts on every poll outcome —
-- 'needs_reauth' on permanent-failure path, 'connected' on success.
-- A successful re-auth + subsequent successful poll self-heals the
-- row → next status fetch returns 'connected' → banner disappears.
--
-- Not a timeseries: only current state matters here. error_code is a
-- short tag (e.g. 'invalid_grant') the UI can render conditionally;
-- last_success_at / last_failure_at are for debugging + the Settings
-- "connector health" surface.
CREATE TABLE IF NOT EXISTS connector_health (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connector_name  STRING NOT NULL,
    status          STRING NOT NULL,
    error_code      STRING,
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, connector_name)
);

CREATE INDEX IF NOT EXISTS connector_health_user_idx
    ON connector_health (user_id);
