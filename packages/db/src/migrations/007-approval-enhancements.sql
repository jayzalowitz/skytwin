-- Approval routing enhancements for Milestone 2: Safe Delegation
-- Adds expiry support and batch grouping to approval requests.

-- Step 1: Add columns as nullable
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS batch_id STRING;

-- Step 2: Backfill expires_at based on urgency
UPDATE approval_requests SET expires_at = CASE
  WHEN urgency = 'immediate' THEN requested_at + INTERVAL '15 minutes'
  WHEN urgency = 'low' THEN requested_at + INTERVAL '72 hours'
  ELSE requested_at + INTERVAL '24 hours'
END WHERE expires_at IS NULL;

-- Step 3: Set NOT NULL on expires_at (batch_id stays nullable)
ALTER TABLE approval_requests ALTER COLUMN expires_at SET NOT NULL;

-- Index for expiry checks (worker polls this)
CREATE INDEX IF NOT EXISTS idx_approval_requests_expires
  ON approval_requests (status, expires_at)
  WHERE status = 'pending';

-- Index for batch lookups
CREATE INDEX IF NOT EXISTS idx_approval_requests_batch
  ON approval_requests (batch_id)
  WHERE batch_id IS NOT NULL;
