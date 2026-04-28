-- 022-forwarded-signals-ledger.sql
-- Persistent ledger of signals already forwarded from the worker to the API.
--
-- The worker has always had an in-memory SignalDeduper, but `tsx watch`
-- restarts (and crashes, and `pnpm dev` reloads) wipe it. After a restart
-- the worker re-emits everything still matching the connector's "what
-- counts as new" filter (Gmail's `is:unread` returns the same hundred
-- threads), each producing a fresh decision + approval downstream.
--
-- This table lets the deduper survive restarts: hydrate on startup, write
-- through on every mark. `forwarded_at` is the truth-of-record for the
-- 24h TTL — the in-memory map is just a hot cache.

CREATE TABLE IF NOT EXISTS forwarded_signals (
  user_id      UUID        NOT NULL,
  signal_key   STRING      NOT NULL,        -- e.g. "gmail:sig_gmail_19dd2..."
  forwarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, signal_key)
);

-- Used by the periodic GC sweep that drops rows past the TTL window.
CREATE INDEX IF NOT EXISTS forwarded_signals_forwarded_at_idx
    ON forwarded_signals (forwarded_at);
