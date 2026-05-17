-- 049-draft-email-eval-bench.sql
-- Per-user eval-bench gate for the draft-email feature (#301).
--
-- Background. Cost gating (#299) is the safety floor for unbounded
-- LLM spend, but "didn't burn money" is not the same as "produced a
-- draft the user would actually send." Before flipping a user from
-- `drafts_enabled: false` to `true`, we need evidence the generator
-- produces drafts that match the user's voice / length / topical
-- distribution well enough to be useful. This migration adds:
--
--   1. `drafts_eval_passed_at` on twin_profiles. NULL = eval has
--      not been run OR ran but failed. The buildDraftEmailGenerator
--      check (follow-up PR) refuses to construct the generator
--      until this is non-NULL — adding a fifth AND-gate on top of
--      the four already in place (env / per-user / LlmClient /
--      providers).
--
--   2. `draft_email_eval_runs` table — one row per eval run. Stores
--      the full result (metric scores, threshold-pass booleans,
--      sample sizes) for an audit trail. Most-recent-by-user is
--      what `drafts_eval_passed_at` tracks; older runs stay for
--      regression analysis.
--
-- Why a separate table for eval runs rather than inline JSONB on
-- twin_profiles? Audit trail. The first run might pass but a later
-- run after the corpus grows could fail — we need to see the trend.
-- Inline JSONB would clobber the prior result every time.

ALTER TABLE twin_profiles
  ADD COLUMN IF NOT EXISTS drafts_eval_passed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS draft_email_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Number of (inbound, user-reply) pairs the run was scored over.
  corpus_size INT NOT NULL,
  -- Aggregate scores (0.0 - 1.0 for ratio-shaped metrics, raw for
  -- length-sigma).
  voice_score FLOAT NOT NULL DEFAULT 0,
  topical_score FLOAT NOT NULL DEFAULT 0,
  length_score FLOAT NOT NULL DEFAULT 0,
  -- Boolean: did this run clear ALL configured thresholds?
  passed BOOL NOT NULL DEFAULT false,
  -- Threshold constants captured at run time so future tuning is
  -- visible in the audit trail. JSONB so we can add new metrics
  -- without a schema migration.
  thresholds JSONB NOT NULL DEFAULT '{}',
  -- Optional human-readable reason for failure (or pass).
  notes STRING NOT NULL DEFAULT '',
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Hot-path lookup: "what's the latest eval for this user?"
  INDEX (user_id, ran_at DESC)
);
