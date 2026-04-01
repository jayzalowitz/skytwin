-- Trust tier audit trail for Milestone 2: Safe Delegation
-- Records every trust tier change (promotion or regression) with evidence.

CREATE TABLE IF NOT EXISTS trust_tier_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  old_tier STRING NOT NULL,
  new_tier STRING NOT NULL,
  direction STRING NOT NULL,  -- 'promotion' or 'regression'
  trigger_reason STRING NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_tier_audit_user (user_id, created_at DESC),
  INDEX idx_tier_audit_direction (direction, created_at DESC)
);
