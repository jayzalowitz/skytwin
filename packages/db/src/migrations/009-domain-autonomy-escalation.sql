-- Domain-specific autonomy and escalation triggers for Milestone 2: Safe Delegation

-- Per-user, per-domain trust tier overrides.
-- A user might have HIGH_AUTONOMY globally but LOW_AUTONOMY for finance.
CREATE TABLE IF NOT EXISTS domain_autonomy_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  domain STRING NOT NULL,
  trust_tier STRING NOT NULL,
  max_spend_per_action_cents INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, domain),
  INDEX idx_domain_autonomy_user (user_id)
);

-- Configurable escalation triggers per user.
CREATE TABLE IF NOT EXISTS escalation_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  trigger_type STRING NOT NULL,
  conditions JSONB NOT NULL,
  enabled BOOL NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_escalation_triggers_user (user_id, enabled)
);
