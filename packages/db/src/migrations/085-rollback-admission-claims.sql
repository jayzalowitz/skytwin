-- #695: bounded, single-use rollback claim lifecycle.  This migration only
-- stores admission authority; it does not enable any dispatch path.
ALTER TABLE rollback_admissions
  ADD COLUMN IF NOT EXISTS lifecycle_status STRING NOT NULL DEFAULT 'admitted',
  ADD COLUMN IF NOT EXISTS claim_token_hash STRING,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terminalized_at TIMESTAMPTZ;

ALTER TABLE rollback_admissions
  ADD CONSTRAINT rollback_admission_lifecycle_status_ck
  CHECK (lifecycle_status IN ('admitted', 'claimed', 'terminal'));

-- Existing 084 terminal rows are already final and must not become claimable
-- when this lifecycle is introduced.
UPDATE rollback_admissions ra
SET lifecycle_status = 'terminal', terminalized_at = COALESCE(ra.terminalized_at, tl.terminal_at)
FROM rollback_terminal_ledger tl
WHERE tl.admission_id = ra.id AND ra.lifecycle_status <> 'terminal';

CREATE UNIQUE INDEX IF NOT EXISTS rollback_admissions_claim_token_idx
  ON rollback_admissions (claim_token_hash)
  WHERE claim_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS rollback_admissions_claim_expiry_idx
  ON rollback_admissions (claim_expires_at)
  WHERE lifecycle_status = 'claimed';
