-- 024-connector-cursors.sql
-- Persistent cursors for incremental connector polling.
--
-- The Gmail connector still queries `is:unread` every 10s and re-emits
-- everything matching, dedup-suppressed downstream. That works but is
-- wasteful: real users will burn the project's Gmail API quota fast,
-- and the symptom that motivated #102 (re-emit on restart) only stays
-- silent because of the dedupe ledger added in PR #104.
--
-- The right fix is the Gmail History API:
--   GET users/me/messages → store the latest historyId once
--   GET users/me/history?startHistoryId=<stored> → only deltas thereafter
--
-- That requires the cursor to survive worker restarts. This table holds it.
-- Calendar's `syncToken` flow needs the same shape, so the column is generic
-- and named `cursor_value` rather than `history_id`.

CREATE TABLE IF NOT EXISTS connector_cursors (
  user_id      UUID        NOT NULL,
  provider     STRING      NOT NULL,        -- 'gmail', 'google_calendar', …
  cursor_kind  STRING      NOT NULL,        -- 'history_id', 'sync_token', …
  cursor_value STRING      NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider, cursor_kind)
);

-- updated_at is bumped by the repository's UPSERT (`updated_at = now()` in
-- the ON CONFLICT clause). CRDB doesn't run PL/pgSQL triggers the same way
-- Postgres does, so we keep this column maintenance in app code — same
-- pattern as oauth_tokens / twin_profiles / mempalace tables.
