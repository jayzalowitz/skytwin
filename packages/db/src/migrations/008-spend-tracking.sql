-- Spend tracking for Milestone 2: Safe Delegation
-- Tracks per-action estimated and actual costs for rolling daily limit enforcement.

CREATE TABLE IF NOT EXISTS spend_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  action_id STRING NOT NULL,
  decision_id STRING NOT NULL,
  estimated_cost_cents INT NOT NULL,
  actual_cost_cents INT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at TIMESTAMPTZ,
  INDEX idx_spend_user_time (user_id, recorded_at DESC),
  INDEX idx_spend_action (action_id)
);
