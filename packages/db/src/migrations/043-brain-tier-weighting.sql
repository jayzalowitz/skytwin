-- #251 Layer 2 + companion fields.
--
-- Adds the per-user toggles + calibration band that the gbrain retrieval
-- layer reads when applying the authoring-tier multiplier in the RRF fold.
-- Default is OFF — Layer 2 ships dark and is opt-in until the
-- `realistic-retrieval` eval confirms recall@5 improves on the labeled set.
--
-- Calibration band:
--   sparse  → user has <100 user_sent_* pages in last 90d; cap the multiplier
--             aggressively so we don't amplify a signal that isn't there
--   normal  → default; use the mid-band weights from the issue spec
--   dense   → user has >1000 user_sent_* pages in last 90d; use the wide
--             multiplier spread so SNR difference compounds

ALTER TABLE brain_settings
  ADD COLUMN IF NOT EXISTS tier_weighting BOOL NOT NULL DEFAULT false;

ALTER TABLE brain_settings
  ADD COLUMN IF NOT EXISTS tier_calibration STRING NOT NULL DEFAULT 'normal'
    CHECK (tier_calibration IN ('sparse', 'normal', 'dense'));
