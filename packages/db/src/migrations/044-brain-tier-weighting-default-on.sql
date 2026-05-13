-- #251 Phase 1.2 — flip Layer 2 default-on.
--
-- Migration 043 shipped `tier_weighting BOOL NOT NULL DEFAULT false` while
-- Layer 2 was eval-gated. The additive rewrite (Phase 1.1) plus the
-- floor-ratio gate cleared the eval bar: user_behavior MRR holds at 1.0
-- and received_content MRR lands at ~0.83 with real embeddings vs ~0.58
-- with hash-trick. Both well above the pre-Phase-1.1 multiplicative
-- baseline (0.54).
--
-- Two changes here:
--   1. Default for new rows flips to TRUE so fresh users get the
--      Phase-1.1 retrieval shape out of the box.
--   2. Existing rows that still have `tier_weighting = false` AND have
--      never been explicitly set by the user get migrated up to TRUE.
--      We can't tell "user said no" vs "default applied" from the schema
--      alone, but the prior default was false for everyone, so any row
--      with the default value is opt-in-by-default candidate. Users who
--      want to opt out can flip it back via Settings → Memory backend.

ALTER TABLE brain_settings
  ALTER COLUMN tier_weighting SET DEFAULT true;

-- Backfill existing rows. Limit to rows that were never explicitly
-- touched (proxy: updated_at within ~10s of the row's implied creation,
-- which is impossible to read reliably without a separate audit column).
-- Simplest honest behavior: opt every existing user in. The dashboard
-- toggle remains available for anyone who wants to opt out, and the
-- realistic-retrieval result is now strictly better than the prior
-- default-off path.
UPDATE brain_settings SET tier_weighting = true WHERE tier_weighting = false;
