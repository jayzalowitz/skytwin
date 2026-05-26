-- 062-access-log.sql
-- Audit log for sensitive-data access (#393).
--
-- Every credential-vault decryption and every API request that
-- touches sensitive per-user data should write a row here. The
-- foundation PR wires only the credential-vault decryption path
-- (the highest-value forensic surface — that's where a compromised
-- worker process or insider would extract refresh tokens). API-route
-- instrumentation and the Settings page that surfaces "your access
-- log" are tracked as follow-ups under the same issue.
--
-- Shape:
--   (id, user_id, actor, action, resource_type, resource_id, request_id, occurred_at)
--
-- `actor` is the process / role that made the access ("worker",
-- "api", "user-self", "admin", "automation"). `action` is a short
-- enum-y string ("decrypt_oauth_token", "read_memory_page",
-- "list_decisions"). `resource_type` + `resource_id` identify what
-- was touched ("oauth_token" / row id, "decision" / decision id).
-- `request_id` is the correlation id from the originating request
-- (HTTP X-Request-Id when available, generated UUID otherwise).
--
-- ON DELETE CASCADE matches the convention from migration 061 — when
-- a user is purged via the right-to-erasure flow (#376), their audit
-- log goes with them. Forensic value vs. privacy: SkyTwin sides with
-- the user's "delete everything" right.

CREATE TABLE IF NOT EXISTS access_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor         STRING NOT NULL,
    action        STRING NOT NULL,
    resource_type STRING NOT NULL,
    resource_id   STRING,
    request_id    STRING,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The Settings "your access log" page (#393 follow-up) will read by
-- (user_id, occurred_at DESC) so an index on that pair keeps the
-- per-user time-range scan cheap even when the table grows large.
CREATE INDEX IF NOT EXISTS access_log_user_time_idx
    ON access_log (user_id, occurred_at DESC);
