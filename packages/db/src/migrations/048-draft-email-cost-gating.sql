-- 048-draft-email-cost-gating.sql
-- Cost-gating infrastructure for the draft-email candidate generator (#299).
--
-- Background. When SKYTWIN_DRAFTS_ENABLED=true AND a user's
-- twin_profiles.drafts_enabled is true (#302), every email signal with
-- `requiresResponse: true` triggers an LLM call via
-- DraftEmailCandidateGenerator.generate(). Spend is currently bounded
-- only by the configured provider's per-token price and the inbound
-- email rate — a user with a heavy inbox and a paid provider could burn
-- meaningful $$ with no per-feature cap. This migration adds two
-- complementary gates:
--
--   1. Per-user per-day CALL cap. Coarse safety net independent of
--      per-token cost. Lives as `drafts_daily_call_cap` on twin_profiles
--      alongside the existing `drafts_enabled` flag. Default 100
--      calls/24h — conservative for v1; tunable per user later.
--
--   2. Per-user per-day SPEND cap. Already exists globally on
--      AutonomySettings.maxDailySpendCents (and is enforced by
--      SpendTracker.checkDailyLimit). This migration adds the per-call
--      ledger that the cost gate writes to so that estimated cost lands
--      in spend_records via the existing single recording site — no new
--      spend-tracking surface.
--
-- The `draft_email_calls` table is the per-feature call ledger. Each
-- attempt to draft (whether it succeeds or fails on the LLM side, but
-- AFTER the gate decision to proceed) writes one row. We count rows in
-- the last 24h to enforce the call cap.
--
-- Why a dedicated table rather than filtering spend_records by some
-- `feature` column? spend_records is generic across every action type
-- and doesn't carry an action-type marker. Adding one would be invasive
-- and turn every spend insert into a "and remember to tag it" footgun.
-- A dedicated call ledger keeps the draft-email feature self-contained
-- and is what the issue calls for ("per-user per-day call cap … lives
-- somewhere queryable per user").

ALTER TABLE twin_profiles
  ADD COLUMN IF NOT EXISTS drafts_daily_call_cap INT NOT NULL DEFAULT 100;

CREATE TABLE IF NOT EXISTS draft_email_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- decision_id is nullable because the call ledger is also written
  -- when the gate fires BEFORE a decision row exists (the candidate
  -- generator runs during the candidate-generation phase, where the
  -- decision row already exists, but we keep the FK constraint loose
  -- to avoid coupling future refactors of the generation pipeline).
  decision_id UUID,
  -- Estimated cost at gate time. Zero for embedded/Ollama. We record
  -- the estimate, not the actual, because the gate runs PRE-call;
  -- the SpendTracker reconciles actual via spend_records.
  estimated_cost_cents INT NOT NULL DEFAULT 0,
  -- Which provider the LLM call would route to. Useful for the cost
  -- dashboard (#183) and for verifying "embedded preferred" is taking
  -- effect in production.
  provider STRING,
  -- Did the call succeed? Tracking this on the ledger row lets us
  -- distinguish "gate let it through, LLM failed" from "gate let it
  -- through, LLM succeeded" without joining spend_records.
  succeeded BOOL NOT NULL DEFAULT true,
  called_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The hot-path lookup is "calls in the last 24h for this user."
  -- Index on (user_id, called_at DESC) makes that O(log n + rows in
  -- window) instead of full-scan.
  INDEX (user_id, called_at DESC)
);
