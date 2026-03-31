-- SkyTwin Database Schema for CockroachDB
-- This schema defines the complete data model for the SkyTwin digital twin system.

-- ============================================================================
-- Users and Identity
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email STRING NOT NULL UNIQUE,
  name STRING NOT NULL,
  trust_tier STRING NOT NULL DEFAULT 'observer',
  autonomy_settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  provider STRING NOT NULL,
  account_id STRING NOT NULL,
  scopes STRING[] NOT NULL DEFAULT '{}',
  is_active BOOL NOT NULL DEFAULT true,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, account_id)
);

-- ============================================================================
-- Twin State (versioned)
-- ============================================================================

CREATE TABLE IF NOT EXISTS twin_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) UNIQUE,
  version INT NOT NULL DEFAULT 1,
  preferences JSONB NOT NULL DEFAULT '[]',
  inferences JSONB NOT NULL DEFAULT '[]',
  risk_tolerance JSONB NOT NULL DEFAULT '{}',
  spend_norms JSONB NOT NULL DEFAULT '{}',
  communication_style JSONB NOT NULL DEFAULT '{}',
  routines JSONB NOT NULL DEFAULT '[]',
  domain_heuristics JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS twin_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES twin_profiles(id),
  version INT NOT NULL,
  snapshot JSONB NOT NULL,
  changed_fields STRING[] NOT NULL DEFAULT '{}',
  reason STRING,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (profile_id, version DESC)
);

-- ============================================================================
-- Preferences (normalized)
-- ============================================================================

CREATE TABLE IF NOT EXISTS preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  domain STRING NOT NULL,
  key STRING NOT NULL,
  value JSONB NOT NULL,
  confidence STRING NOT NULL,
  source STRING NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]',
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id, domain)
);

-- ============================================================================
-- Decisions and Events
-- ============================================================================

CREATE TABLE IF NOT EXISTS decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  situation_type STRING NOT NULL,
  raw_event JSONB NOT NULL,
  interpreted_situation JSONB NOT NULL,
  domain STRING NOT NULL,
  urgency STRING NOT NULL DEFAULT 'normal',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id, created_at DESC),
  INDEX (user_id, domain, created_at DESC)
);

CREATE TABLE IF NOT EXISTS candidate_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id),
  action_type STRING NOT NULL,
  description STRING NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}',
  predicted_user_preference STRING NOT NULL,
  risk_assessment JSONB NOT NULL,
  reversible BOOL NOT NULL DEFAULT true,
  estimated_cost INT, -- cents
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (decision_id)
);

-- ============================================================================
-- Decision Outcomes
-- ============================================================================

CREATE TABLE IF NOT EXISTS decision_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id) UNIQUE,
  selected_action_id UUID REFERENCES candidate_actions(id),
  auto_executed BOOL NOT NULL DEFAULT false,
  requires_approval BOOL NOT NULL DEFAULT false,
  escalation_reason STRING,
  explanation STRING NOT NULL,
  confidence FLOAT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Policies
-- ============================================================================

CREATE TABLE IF NOT EXISTS action_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name STRING NOT NULL,
  domain STRING NOT NULL,
  rules JSONB NOT NULL DEFAULT '[]',
  priority INT NOT NULL DEFAULT 0,
  is_active BOOL NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id, domain)
);

-- ============================================================================
-- Approval Requests
-- ============================================================================

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  decision_id UUID NOT NULL REFERENCES decisions(id),
  candidate_action JSONB NOT NULL,
  reason STRING NOT NULL,
  urgency STRING NOT NULL DEFAULT 'normal',
  status STRING NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  response JSONB,
  INDEX (user_id, status)
);

-- ============================================================================
-- Execution
-- ============================================================================

CREATE TABLE IF NOT EXISTS execution_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id),
  action_id UUID NOT NULL REFERENCES candidate_actions(id),
  status STRING NOT NULL DEFAULT 'pending',
  steps JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (decision_id)
);

CREATE TABLE IF NOT EXISTS execution_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES execution_plans(id) UNIQUE,
  success BOOL NOT NULL,
  outputs JSONB NOT NULL DEFAULT '{}',
  error STRING,
  rollback_available BOOL NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Explanation / Audit
-- ============================================================================

CREATE TABLE IF NOT EXISTS explanation_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id),
  what_happened STRING NOT NULL,
  evidence_used JSONB NOT NULL DEFAULT '[]',
  preferences_invoked STRING[] NOT NULL DEFAULT '{}',
  confidence_reasoning STRING NOT NULL,
  action_rationale STRING NOT NULL,
  escalation_rationale STRING,
  correction_guidance STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (decision_id)
);

-- ============================================================================
-- Feedback
-- ============================================================================

CREATE TABLE IF NOT EXISTS feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  decision_id UUID NOT NULL REFERENCES decisions(id),
  type STRING NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id, created_at DESC),
  INDEX (decision_id)
);
