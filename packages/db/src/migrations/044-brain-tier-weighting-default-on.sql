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
--
--   1. Default for new rows flips to TRUE so fresh users get the
--      Phase-1.1 retrieval shape out of the box.
--
--   2. **Unconditional opt-in for existing rows.** Every existing
--      `tier_weighting = false` row gets flipped to true.
--
-- IMPORTANT: this DOES override explicit user opt-outs that existed at
-- migration time. We don't have a "set by user" audit column to
-- distinguish "default applied" from "user said no," and Phase 1.1's
-- new retrieval shape is materially better than the prior default-off
-- behavior on both the user_behavior and aggregate metrics. The honest
-- call is that the prior opt-out was a workaround for a bug we now
-- fixed, so we re-enable for everyone and leave the dashboard toggle
-- available for anyone who wants to opt back out.
--
-- If preserving prior opt-outs becomes important later, add an
-- `tier_weighting_explicit BOOL` audit column in a follow-up migration
-- and gate this UPDATE on it.

ALTER TABLE brain_settings
  ALTER COLUMN tier_weighting SET DEFAULT true;

UPDATE brain_settings SET tier_weighting = true WHERE tier_weighting = false;
