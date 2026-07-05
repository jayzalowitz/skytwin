-- 070-watch-runs.sql
-- The canonical record of each Watch firing (#519 part 3b). A Watch (069) is a
-- read-only signal watcher; when the worker scheduler fires it, it matches the
-- user's recent signals against the watch's filter and records the result here.
--
-- This row IS the firing's explanation (the read-only equivalent of an
-- ExplanationRecord): `matched_refs` is the evidence (which signals matched),
-- `summary` is the digest/notify output, and the watch's own `filter` (joinable
-- via watch_id) is the "why". The ambient surfaces (briefing projection,
-- notifications — a later part) READ from this table; it is the single source
-- of truth, never a separate copy.
--
-- Only meaningful firings (>=1 match) are recorded; a firing that matched
-- nothing still advances the watch's next_run_at but writes no row here, so the
-- table stays small and the run history is signal, not noise.

CREATE TABLE IF NOT EXISTS watch_runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    watch_id      UUID NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    action        STRING NOT NULL,
    matched_count INT NOT NULL DEFAULT 0,
    summary       STRING NOT NULL DEFAULT '',
    matched_refs  JSONB NOT NULL DEFAULT '[]'::JSONB,
    CONSTRAINT watch_runs_action_chk CHECK (action IN ('digest', 'notify'))
);

-- Per-watch run history (the Watches page reads a watch's recent runs).
CREATE INDEX IF NOT EXISTS watch_runs_watch_idx ON watch_runs (watch_id, ran_at DESC);

-- Per-user recent runs (the briefing projection reads across the user's watches).
CREATE INDEX IF NOT EXISTS watch_runs_user_idx ON watch_runs (user_id, ran_at DESC);
