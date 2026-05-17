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
  ironclaw_channel STRING DEFAULT 'skytwin',
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
  -- #302: per-user feature flag for the draft-email candidate
  -- generator. The wiring in #295 (v0.6.30.0) is gated by a process-
  -- wide env var (SKYTWIN_DRAFTS_ENABLED); this column AND-gates the
  -- final check so staged per-user rollout is possible. Default FALSE.
  drafts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- #299: per-user per-day call cap for the draft-email feature.
  -- Independent of the spend cap on AutonomySettings — coarse safety
  -- net for the "heavy-inbox + paid-provider" cost spiral the issue
  -- describes. Default 100 calls / 24h; tunable per user.
  drafts_daily_call_cap INT NOT NULL DEFAULT 100,
  -- #301: per-user eval-bench gate. NULL = eval not run / not
  -- passing. Non-NULL = the most recent eval run's pass timestamp.
  -- buildDraftEmailGenerator refuses (in a follow-up PR) to wire
  -- the generator unless this is non-NULL — quality gate on top of
  -- the cost / opt-in gates.
  drafts_eval_passed_at TIMESTAMPTZ,
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
  action_id UUID REFERENCES candidate_actions(id),
  status STRING NOT NULL DEFAULT 'pending',
  steps JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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

CREATE TABLE IF NOT EXISTS execution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES execution_plans(id),
  step_id STRING,
  event_type STRING NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_execution_events_plan ON execution_events (plan_id, created_at ASC);

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
  -- #305: link to the capability_provenance_nodes row this explanation's
  -- action originated from. NULL for engine-originated actions; populated
  -- when the candidate carried a capability-pipeline origin. The FK and
  -- partial index are added in migration 051 (out-of-line ADD CONSTRAINT
  -- with a fixed name; re-runs raise SQLSTATE 42710 which the migration
  -- runner swallows as idempotent DDL). Both the bootstrap path and the
  -- migration path therefore converge on the same final shape — column
  -- with ON DELETE SET NULL FK and a partial index. The FK can't be
  -- inlined here because `capability_provenance_nodes` is declared by
  -- migration 027, not this bootstrap schema.
  capability_provenance_node_id UUID,
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

-- ============================================================================
-- Service Credentials & IronClaw Integration
-- ============================================================================

CREATE TABLE IF NOT EXISTS service_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service STRING NOT NULL,
  credential_key STRING NOT NULL,
  credential_value STRING NOT NULL,
  label STRING,
  ironclaw_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service, credential_key)
);
CREATE INDEX idx_service_credentials_service ON service_credentials (service);

CREATE TABLE IF NOT EXISTS credential_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter STRING NOT NULL,
  integration STRING NOT NULL,
  integration_label STRING NOT NULL,
  description STRING,
  field_key STRING NOT NULL,
  field_label STRING NOT NULL,
  field_placeholder STRING,
  is_secret BOOLEAN NOT NULL DEFAULT false,
  is_optional BOOLEAN NOT NULL DEFAULT false,
  skills STRING[] NOT NULL DEFAULT ARRAY[]::STRING[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (adapter, integration, field_key)
);
CREATE INDEX idx_credential_requirements_adapter ON credential_requirements (adapter);
CREATE INDEX idx_credential_requirements_integration ON credential_requirements (integration);

CREATE TABLE IF NOT EXISTS ai_provider_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider STRING NOT NULL,
  api_key STRING NOT NULL DEFAULT '',
  model STRING NOT NULL,
  base_url STRING,
  priority INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);
CREATE INDEX idx_ai_provider_settings_user ON ai_provider_settings (user_id, priority);

CREATE TABLE IF NOT EXISTS ironclaw_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name STRING NOT NULL UNIQUE,
  description STRING,
  action_types STRING[] NOT NULL DEFAULT '{}',
  requires_credentials STRING[] NOT NULL DEFAULT '{}',
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ironclaw_tools_discovered ON ironclaw_tools (discovered_at DESC);

CREATE TABLE IF NOT EXISTS lifebooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_name STRING NOT NULL,
  importance STRING NOT NULL CHECK (importance IN ('core', 'secondary', 'emerging')),
  sample_signals JSONB NOT NULL DEFAULT '[]',
  suggested_capabilities JSONB NOT NULL DEFAULT '[]',
  wing_id UUID,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at TIMESTAMPTZ,
  UNIQUE (user_id, domain_name)
);
CREATE INDEX IF NOT EXISTS lifebooks_user_visible_idx
  ON lifebooks (user_id, importance, last_seen_at DESC)
  WHERE hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS lifebooks_user_all_idx ON lifebooks (user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash BYTES NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  used_for STRING
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_active_idx
  ON recovery_codes (user_id, used_at) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS recovery_codes_user_all_idx
  ON recovery_codes (user_id, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS vacation_mode_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS model_downloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id STRING NOT NULL,
  target_path STRING NOT NULL,
  total_bytes INT8 NOT NULL,
  bytes_downloaded INT8 NOT NULL DEFAULT 0,
  sha256_expected STRING NOT NULL,
  status STRING NOT NULL CHECK (status IN (
    'pending', 'downloading', 'paused', 'verifying', 'installing', 'complete', 'failed', 'cancelled'
  )),
  error STRING,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS model_downloads_user_all_idx
  ON model_downloads (user_id, started_at DESC);
-- Enforces "at most one active download per (user, model)" at the DB
-- level so concurrent /downloads/start can't race past findActive().
CREATE UNIQUE INDEX IF NOT EXISTS model_downloads_user_active_uniq
  ON model_downloads (user_id, model_id)
  WHERE status NOT IN ('complete', 'failed', 'cancelled');
