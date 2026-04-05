-- Approval routing enhancements for Milestone 2: Safe Delegation
-- Adds expiry support and batch grouping to approval requests.

-- Add expires_at with NOT NULL + DEFAULT to avoid CockroachDB async backfill conflict
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours';
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS batch_id STRING;

-- Index for expiry checks (worker polls this)
CREATE INDEX IF NOT EXISTS idx_approval_requests_expires
  ON approval_requests (status, expires_at)
  WHERE status = 'pending';

-- Index for batch lookups
CREATE INDEX IF NOT EXISTS idx_approval_requests_batch
  ON approval_requests (batch_id)
  WHERE batch_id IS NOT NULL;
