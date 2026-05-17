-- 047-twin-profile-drafts-enabled.sql
-- Per-user feature flag for the draft-email candidate generator (#302).
--
-- The wiring landed in #295 (v0.6.30.0) behind a single process-wide env
-- var: SKYTWIN_DRAFTS_ENABLED. That shape is right for internal dogfood
-- and incident kill-switch, but wrong for staged rollout — every user
-- gets it or no user does. This migration adds the per-user form.
--
-- Default FALSE: existing users are NOT auto-opted-in. The env var stays
-- as a global override / kill switch (a future incident can disable the
-- feature for everyone without a DB update). When both are set,
-- effective state is `env_on AND per_user_on`.
--
-- Type is BOOLEAN NOT NULL DEFAULT FALSE. NOT NULL avoids tri-state
-- ambiguity ("missing == false" vs "missing == not yet decided") which
-- the gate check would have to handle. The default propagates to all
-- existing twin_profiles rows on migration apply.

ALTER TABLE twin_profiles
  ADD COLUMN IF NOT EXISTS drafts_enabled BOOLEAN NOT NULL DEFAULT FALSE;
