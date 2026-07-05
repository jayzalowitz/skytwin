-- 069-watches.sql
-- No-code routines, a.k.a. "watches" (#519 part 2). A Watch is a user-authored,
-- READ-ONLY signal watcher: on a schedule it matches recent signals against a
-- filter and produces a digest / notification. It never sends, replies,
-- schedules, or spends — so it takes no action to gate. Action-taking scheduled
-- routines are a different, policy-gated primitive (the IronClaw cron
-- `/api/routines` path); this table is deliberately separate from that.
--
-- Shape mirrors the shared-types Routine / RoutineSpec: cadence +
-- (hour_of_day / day_of_week) + filter(JSONB) + action + status. `filter` holds
-- the RoutineFilter (sources / fromContains / keywords / domains).
--
-- CHECK constraints on the enum-y columns reject a bad cadence/action/status at
-- write time — a mocked-query test would otherwise pass while real CRDB rejects
-- the row.

CREATE TABLE IF NOT EXISTS watches (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          STRING NOT NULL,
    source_text   STRING NOT NULL,
    cadence       STRING NOT NULL,
    hour_of_day   INT,
    day_of_week   INT,
    filter        JSONB NOT NULL DEFAULT '{}'::JSONB,
    action        STRING NOT NULL,
    status        STRING NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_run_at   TIMESTAMPTZ,
    next_run_at   TIMESTAMPTZ,
    CONSTRAINT watches_cadence_chk CHECK (cadence IN ('hourly', 'daily', 'weekly')),
    CONSTRAINT watches_action_chk  CHECK (action IN ('digest', 'notify')),
    CONSTRAINT watches_status_chk  CHECK (status IN ('draft', 'active', 'paused')),
    CONSTRAINT watches_hour_chk    CHECK (hour_of_day IS NULL OR (hour_of_day BETWEEN 0 AND 23)),
    CONSTRAINT watches_dow_chk     CHECK (day_of_week IS NULL OR (day_of_week BETWEEN 0 AND 6))
);

-- Per-user listing (the Watches page reads by user, newest first).
CREATE INDEX IF NOT EXISTS watches_user_idx ON watches (user_id, created_at DESC);

-- The scheduler (a later part) claims due watches by (status, next_run_at).
CREATE INDEX IF NOT EXISTS watches_due_idx ON watches (status, next_run_at);
