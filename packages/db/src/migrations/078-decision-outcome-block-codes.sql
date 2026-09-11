-- Stable machine-readable policy/scope reasons, kept separate from explanation
-- prose so UI remediation never depends on parsing human text.
ALTER TABLE decision_outcomes
  ADD COLUMN IF NOT EXISTS block_codes JSONB NOT NULL DEFAULT '[]'::JSONB;
