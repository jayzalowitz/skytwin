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
  execution_authority_revision UUID NOT NULL DEFAULT gen_random_uuid(),
  ironclaw_channel STRING DEFAULT 'skytwin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_policy_authority (
  singleton BOOL PRIMARY KEY DEFAULT true CHECK (singleton),
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO execution_policy_authority (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS oauth_connection_authority (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider STRING NOT NULL,
  generation UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS oauth_account_connection_authority (
  provider STRING NOT NULL,
  account_key STRING NOT NULL,
  generation UUID NOT NULL DEFAULT gen_random_uuid(),
  invalidated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '15 minutes'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, account_key)
) WITH (ttl_expiration_expression = 'expires_at');
CREATE TABLE IF NOT EXISTS oauth_new_user_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider STRING NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_owner_key STRING,
  claimed_account_key STRING,
  claimed_owner_generation UUID,
  claim_generation UUID,
  CHECK (expires_at > issued_at)
) WITH (ttl_expiration_expression = 'expires_at');
CREATE INDEX IF NOT EXISTS oauth_new_user_authorizations_expires_idx
  ON oauth_new_user_authorizations (expires_at);

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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT twin_profiles_id_user_id_idx UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS twin_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES twin_profiles(id),
  version INT NOT NULL,
  snapshot JSONB NOT NULL,
  changed_fields STRING[] NOT NULL DEFAULT '{}',
  reason STRING,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT twin_profile_versions_profile_version_idx UNIQUE (profile_id, version)
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
  CONSTRAINT decisions_id_user_id_idx UNIQUE (id, user_id),
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
  -- #324: execution_plan_id column + FK + index added below, after
  -- the execution_plans table is defined (forward references aren't
  -- allowed during a single multi-statement script run). See the
  -- ALTER TABLE / CREATE INDEX block under "Execution".
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
  execution_denied_at TIMESTAMPTZ,
  execution_denial_explanation_id UUID,
  CONSTRAINT approval_requests_decision_owner_fk
    FOREIGN KEY (decision_id, user_id) REFERENCES decisions (id, user_id),
  CONSTRAINT approval_requests_id_owner_decision_idx UNIQUE (id, user_id, decision_id),
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
  evidence_schema_version INT NOT NULL DEFAULT 1,
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
  evidence_schema_version INT NOT NULL DEFAULT 1,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- #695: durable rollback claims. The terminal ledger is declared below,
-- after explanation_records exists.
CREATE TABLE IF NOT EXISTS rollback_admissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  candidate_action_id UUID NOT NULL REFERENCES candidate_actions(id),
  decision_outcome_id UUID NOT NULL REFERENCES decision_outcomes(id),
  execution_result_id UUID NOT NULL REFERENCES execution_results(id),
  adapter_name STRING NOT NULL,
  provider_plan_id STRING NOT NULL,
  lifecycle_status STRING NOT NULL DEFAULT 'admitted',
  claim_token_hash STRING,
  claimed_at TIMESTAMPTZ,
  claim_expires_at TIMESTAMPTZ,
  terminalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rollback_admission_one_claim_per_action UNIQUE (candidate_action_id),
  CONSTRAINT rollback_admission_owner_graph UNIQUE (id, user_id)
  ,CONSTRAINT rollback_admission_lifecycle_status_ck CHECK (lifecycle_status IN ('admitted', 'claimed', 'terminal'))
);

CREATE TABLE IF NOT EXISTS execution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES execution_plans(id),
  step_id STRING,
  event_type STRING NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  evidence_schema_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_execution_events_plan ON execution_events (plan_id, created_at ASC);

-- #324: structural linkage from decision_outcomes to execution_plans.
-- Added here (post `execution_plans` definition) to avoid the forward
-- FK reference that would break a fresh-DB bootstrap from schema.sql.
-- Migration 055 applies the same column + index to existing
-- databases; the named index keeps both paths in sync (IF NOT EXISTS
-- checks by name, so the fresh-DB bootstrap that runs schema.sql
-- THEN migration 055 won't create a duplicate).
ALTER TABLE decision_outcomes
  ADD COLUMN IF NOT EXISTS execution_plan_id UUID REFERENCES execution_plans(id);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_execution_plan
  ON decision_outcomes (execution_plan_id)
  WHERE execution_plan_id IS NOT NULL;

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

-- Required before rollback_terminal_ledger's composite explanation FK.
CREATE UNIQUE INDEX IF NOT EXISTS explanation_records_id_decision_idx
  ON explanation_records (id, decision_id);

CREATE TABLE IF NOT EXISTS rollback_terminal_ledger (
  admission_id UUID PRIMARY KEY REFERENCES rollback_admissions(id),
  user_id UUID NOT NULL,
  decision_id UUID NOT NULL REFERENCES decisions(id),
  status STRING NOT NULL CHECK (status IN ('rolled_back', 'failed', 'unknown')),
  result JSONB NOT NULL DEFAULT '{}',
  explanation_id UUID NOT NULL,
  terminal_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rollback_terminal_owner_fk FOREIGN KEY (admission_id, user_id)
    REFERENCES rollback_admissions(id, user_id),
  CONSTRAINT rollback_terminal_explanation_fk FOREIGN KEY (explanation_id, decision_id)
    REFERENCES explanation_records(id, decision_id),
  CONSTRAINT rollback_terminal_explanation_unique UNIQUE (explanation_id)
);
CREATE INDEX IF NOT EXISTS rollback_admissions_owner_idx
  ON rollback_admissions (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rollback_admissions_claim_token_idx
  ON rollback_admissions (claim_token_hash) WHERE claim_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS rollback_admissions_claim_expiry_idx
  ON rollback_admissions (claim_expires_at) WHERE lifecycle_status = 'claimed';

-- Durable admission record for externally visible effects (#653). An
-- in-progress row is never automatically replayed because generic adapters do
-- not accept provider idempotency keys.
CREATE TABLE IF NOT EXISTS pre_effect_barriers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effect_type STRING NOT NULL CHECK (effect_type IN (
    'assistant_approval', 'event_execution', 'memory_execution', 'routine_registration'
  )),
  idempotency_key STRING NOT NULL,
  status STRING NOT NULL DEFAULT 'reserved' CHECK (status IN (
    'reserved', 'prepared', 'in_progress', 'succeeded', 'blocked', 'failed', 'unknown'
  )),
  decision_id UUID REFERENCES decisions(id) ON DELETE SET NULL,
  action_id UUID REFERENCES candidate_actions(id) ON DELETE SET NULL,
  explanation_id UUID REFERENCES explanation_records(id) ON DELETE SET NULL,
  policy_snapshot JSONB NOT NULL DEFAULT '{}',
  effect_result JSONB NOT NULL DEFAULT '{}',
  failure_reason STRING,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pre_effect_barrier_explanation_required
    CHECK (status = 'reserved' OR explanation_id IS NOT NULL),
  UNIQUE (user_id, effect_type, idempotency_key)
);
CREATE INDEX IF NOT EXISTS pre_effect_barriers_decision_idx
  ON pre_effect_barriers (decision_id) WHERE decision_id IS NOT NULL;

-- Repository-enforced, user-purgeable hash-linked decision receipts (#657).
-- The root is uniquely owned through its decision.
CREATE UNIQUE INDEX IF NOT EXISTS decisions_id_user_id_idx
  ON decisions (id, user_id);
CREATE TABLE IF NOT EXISTS decision_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_receipts_owned_decision_unique UNIQUE (decision_id),
  CONSTRAINT decision_receipts_owned_decision_fk
    FOREIGN KEY (decision_id, user_id) REFERENCES decisions (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS decision_receipts_user_created_idx
  ON decision_receipts (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_receipt_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES decision_receipts(id) ON DELETE CASCADE,
  sequence INT NOT NULL CHECK (sequence > 0),
  event_key STRING NOT NULL CHECK (
    event_key ~ '^[a-z][a-z0-9_]{0,47}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  previous_digest STRING,
  content_digest STRING NOT NULL,
  revision_digest STRING NOT NULL,
  stage STRING NOT NULL CHECK (stage IN (
    'decision_recorded', 'policy_evaluated', 'approval_recorded',
    'execution_admitted', 'execution_recorded', 'feedback_recorded', 'corrected'
  )),
  disposition STRING NOT NULL CHECK (disposition IN (
    'pending', 'allowed', 'deliberate_non_action', 'requires_approval', 'approved',
    'rejected', 'expired', 'blocked', 'succeeded', 'failed', 'unknown', 'corrected'
  )),
  content JSONB NOT NULL,
  trusted BOOL NOT NULL DEFAULT false,
  -- Historical pointers are owner-derived and verified by the repository at
  -- append time, but intentionally are not FKs: deleting a source artifact
  -- must not mutate or strand the retained hash-linked receipt history.
  candidate_action_id UUID,
  barrier_id UUID,
  explanation_id UUID,
  approval_request_id UUID,
  execution_plan_id UUID,
  execution_result_id UUID,
  execution_disposition STRING CHECK (execution_disposition IN ('succeeded', 'failed', 'unknown')),
  correction_of_revision_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_receipt_revision_sequence_unique UNIQUE (receipt_id, sequence),
  CONSTRAINT decision_receipt_revision_event_unique UNIQUE (receipt_id, event_key),
  CONSTRAINT decision_receipt_previous_digest_shape CHECK (
    previous_digest IS NULL OR previous_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT decision_receipt_content_digest_shape CHECK (
    content_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT decision_receipt_revision_digest_shape CHECK (
    revision_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT decision_receipt_execution_result_plan CHECK (
    execution_result_id IS NULL OR execution_plan_id IS NOT NULL
  ),
  CONSTRAINT decision_receipt_execution_disposition_shape CHECK (
    (stage = 'execution_recorded' AND execution_disposition = disposition) OR
    (stage IN ('feedback_recorded', 'corrected') AND
      ((execution_plan_id IS NULL AND execution_disposition IS NULL) OR
       (execution_plan_id IS NOT NULL AND execution_disposition IS NOT NULL))) OR
    (stage NOT IN ('execution_recorded', 'feedback_recorded', 'corrected') AND
      execution_disposition IS NULL)
  ),
  CONSTRAINT decision_receipt_correction_shape CHECK (
    (stage = 'corrected' AND disposition = 'corrected' AND correction_of_revision_id IS NOT NULL)
    OR (stage != 'corrected' AND disposition != 'corrected' AND correction_of_revision_id IS NULL)
  ),
  CONSTRAINT decision_receipt_approval_shape CHECK (
    stage != 'approval_recorded' OR approval_request_id IS NOT NULL
  ),
  CONSTRAINT decision_receipt_execution_shape CHECK (
    stage != 'execution_recorded' OR (
      barrier_id IS NOT NULL AND disposition IN ('succeeded', 'failed', 'unknown')
      AND ((disposition IN ('succeeded', 'failed') AND execution_result_id IS NOT NULL)
        OR disposition = 'unknown')
    )
  ),
  CONSTRAINT decision_receipt_stage_disposition_matrix CHECK (
    (stage = 'decision_recorded' AND disposition = 'pending') OR
    (stage = 'policy_evaluated' AND disposition IN ('allowed', 'deliberate_non_action', 'requires_approval', 'blocked')) OR
    (stage = 'approval_recorded' AND disposition IN ('requires_approval', 'approved', 'rejected', 'expired')) OR
    (stage = 'execution_admitted' AND disposition = 'pending') OR
    (stage = 'execution_recorded' AND disposition IN ('succeeded', 'failed', 'unknown')) OR
    (stage = 'feedback_recorded' AND disposition IN (
      'deliberate_non_action', 'approved', 'rejected', 'expired', 'blocked', 'succeeded', 'failed', 'unknown'
    )) OR
    (stage = 'corrected' AND disposition = 'corrected')
  )
);
CREATE INDEX IF NOT EXISTS decision_receipt_revisions_receipt_created_idx
  ON decision_receipt_revisions (receipt_id, sequence DESC);

-- ============================================================================
-- Feedback
-- ============================================================================

CREATE TABLE IF NOT EXISTS feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  decision_id UUID NOT NULL REFERENCES decisions(id),
  approval_request_id UUID,
  type STRING NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT feedback_events_approval_owner_decision_fk
    FOREIGN KEY (approval_request_id, user_id, decision_id)
    REFERENCES approval_requests (id, user_id, decision_id) ON DELETE CASCADE,
  INDEX (user_id, created_at DESC),
  INDEX (decision_id),
  CONSTRAINT feedback_events_id_owner_decision_idx UNIQUE (id, user_id, decision_id),
  UNIQUE INDEX feedback_events_approval_request_unique_idx (approval_request_id)
    WHERE approval_request_id IS NOT NULL
);

CREATE TABLE IF NOT EXISTS twin_feedback_applications (
  id UUID PRIMARY KEY,
  feedback_event_id UUID NOT NULL,
  user_id UUID NOT NULL,
  decision_id UUID NOT NULL,
  profile_id UUID NOT NULL,
  input_profile_version INT NOT NULL,
  output_profile_version INT NOT NULL,
  changed BOOL NOT NULL,
  output_digest STRING NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT twin_feedback_applications_feedback_unique UNIQUE (feedback_event_id),
  CONSTRAINT twin_feedback_applications_feedback_owner_decision_fk
    FOREIGN KEY (feedback_event_id, user_id, decision_id)
    REFERENCES feedback_events (id, user_id, decision_id) ON DELETE CASCADE,
  CONSTRAINT twin_feedback_applications_profile_owner_fk
    FOREIGN KEY (profile_id, user_id) REFERENCES twin_profiles (id, user_id),
  CONSTRAINT twin_feedback_applications_versions_chk CHECK (
    input_profile_version > 0 AND
    ((changed = true AND output_profile_version = input_profile_version + 1) OR
     (changed = false AND output_profile_version = input_profile_version))
  ),
  CONSTRAINT twin_feedback_applications_digest_chk CHECK (
    output_digest ~ '^[0-9a-f]{64}$'
  )
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

CREATE TABLE IF NOT EXISTS reasoning_mode_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode STRING,
  requires_confirmation BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reasoning_mode_settings_mode_check CHECK (
    mode IS NULL OR mode IN ('on_device', 'verified_private_cloud', 'bring_your_own_provider')
  ),
  CONSTRAINT reasoning_mode_settings_confirmation_check CHECK (
    (mode IS NULL AND requires_confirmation = true)
    OR (mode IS NOT NULL AND requires_confirmation = false)
  )
);

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
  -- #321 importance-override ceremony. JSONB instead of a typed column
  -- so future per-Lifebook state lands without another migration.
  -- Added by migration 056.
  metadata JSONB NOT NULL DEFAULT '{}',
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

CREATE TABLE IF NOT EXISTS memory_action_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint STRING NOT NULL,
  suggestion_id STRING NOT NULL,
  title STRING NOT NULL,
  reason STRING NOT NULL,
  suggested_action STRING NOT NULL,
  action_type STRING NOT NULL,
  action_label STRING NOT NULL,
  action_plan JSONB NOT NULL DEFAULT '{}'::JSONB,
  source_refs STRING[] NOT NULL DEFAULT ARRAY[]::STRING[],
  memory_refs STRING[] NOT NULL DEFAULT ARRAY[]::STRING[],
  source_types STRING[] NOT NULL DEFAULT ARRAY[]::STRING[],
  novelty STRING NOT NULL CHECK (novelty IN ('connection','resurface')),
  confidence FLOAT8 NOT NULL DEFAULT 0,
  provenance STRING NOT NULL DEFAULT 'untrusted_external'
    CHECK (provenance IN ('user_originated','trusted_context','untrusted_external')),
  status STRING NOT NULL DEFAULT 'suggested'
    CHECK (status IN (
      'suggested',
      'processing',
      'queued_approval',
      'auto_executed',
      'blocked_by_policy',
      'learning_needed',
      'execution_failed',
      'execution_ambiguous',
      'execution_unknown',
      'noted_awareness',
      'skipped'
    )),
  attempt_count INT NOT NULL DEFAULT 0,
  last_suggested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempted_at TIMESTAMPTZ,
  last_report JSONB,
  decision_id UUID REFERENCES decisions(id) ON DELETE SET NULL,
  approval_request_id UUID REFERENCES approval_requests(id) ON DELETE SET NULL,
  execution_plan_id UUID REFERENCES execution_plans(id) ON DELETE SET NULL,
  adapter_name STRING,
  policy_reason STRING,
  route_reason STRING,
  next_step STRING,
  evidence_schema_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS memory_action_opportunities_user_status_idx
  ON memory_action_opportunities (user_id, status, last_attempted_at, last_suggested_at DESC);
CREATE INDEX IF NOT EXISTS memory_action_opportunities_user_report_idx
  ON memory_action_opportunities (user_id, last_attempted_at DESC)
  WHERE last_attempted_at IS NOT NULL;

-- Durable one-shot authority for side-effecting memory and approval execution.
CREATE UNIQUE INDEX IF NOT EXISTS decisions_id_user_idx
  ON decisions (id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_actions_id_decision_idx
  ON candidate_actions (id, decision_id);
CREATE UNIQUE INDEX IF NOT EXISTS decision_outcomes_id_decision_action_idx
  ON decision_outcomes (id, decision_id, selected_action_id);
CREATE UNIQUE INDEX IF NOT EXISTS execution_plans_id_decision_action_idx
  ON execution_plans (id, decision_id, action_id);
CREATE TABLE IF NOT EXISTS execution_admission_barriers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope STRING NOT NULL CHECK (scope IN ('memory', 'approval')),
  idempotency_key UUID NOT NULL,
  decision_id UUID NOT NULL,
  action_id UUID NOT NULL,
  execution_plan_id UUID NOT NULL,
  outcome_id UUID NOT NULL,
  explanation_id UUID NOT NULL,
  adapter_name STRING NOT NULL,
  risk_snapshot JSONB NOT NULL,
  policy_snapshot JSONB NOT NULL,
  action_snapshot JSONB NOT NULL,
  outcome_snapshot JSONB NOT NULL,
  status STRING NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'failed', 'ambiguous')),
  observed_result JSONB NOT NULL DEFAULT '{}'::JSONB,
  evidence_schema_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, idempotency_key),
  CONSTRAINT execution_admission_decision_owner_fk
    FOREIGN KEY (decision_id, user_id) REFERENCES decisions (id, user_id),
  CONSTRAINT execution_admission_action_decision_fk
    FOREIGN KEY (action_id, decision_id) REFERENCES candidate_actions (id, decision_id),
  CONSTRAINT execution_admission_plan_graph_fk
    FOREIGN KEY (execution_plan_id, decision_id, action_id)
    REFERENCES execution_plans (id, decision_id, action_id),
  CONSTRAINT execution_admission_outcome_graph_fk
    FOREIGN KEY (outcome_id, decision_id, action_id)
    REFERENCES decision_outcomes (id, decision_id, selected_action_id),
  CONSTRAINT execution_admission_explanation_decision_fk
    FOREIGN KEY (explanation_id, decision_id)
    REFERENCES explanation_records (id, decision_id)
);
CREATE INDEX IF NOT EXISTS execution_admission_barriers_plan_idx
  ON execution_admission_barriers (execution_plan_id);

CREATE TABLE IF NOT EXISTS credential_dispatch_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  oauth_token_id UUID,
  provider STRING,
  account_email STRING,
  credential_revision UUID,
  credential_generation UUID,
  vault_generation UUID,
  adapter_name STRING NOT NULL,
  risk_snapshot JSONB NOT NULL,
  execution_channel STRING,
  mcp_server_id UUID,
  mcp_tool_name STRING,
  execution_authority_revision UUID NOT NULL,
  policy_authority_revision UUID NOT NULL,
  action_id UUID NOT NULL,
  decision_id UUID NOT NULL,
  execution_plan_id UUID NOT NULL,
  authority_kind STRING NOT NULL CHECK (authority_kind IN ('admission', 'receipt')),
  authority_id UUID NOT NULL,
  authority_updated_at TIMESTAMPTZ NOT NULL,
  capability_hash STRING NOT NULL UNIQUE,
  lease_generation UUID NOT NULL,
  state STRING NOT NULL CHECK (
    state IN ('request_started', 'completed', 'failed', 'ambiguous')
  ),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  UNIQUE (execution_plan_id),
  CONSTRAINT credential_dispatch_decision_owner_fk
    FOREIGN KEY (decision_id, user_id) REFERENCES decisions (id, user_id),
  CONSTRAINT credential_dispatch_action_decision_fk
    FOREIGN KEY (action_id, decision_id) REFERENCES candidate_actions (id, decision_id),
  CONSTRAINT credential_dispatch_plan_graph_fk
    FOREIGN KEY (execution_plan_id, decision_id, action_id)
    REFERENCES execution_plans (id, decision_id, action_id)
);
CREATE INDEX IF NOT EXISTS credential_dispatch_leases_token_state_idx
  ON credential_dispatch_leases (oauth_token_id, state, expires_at);
CREATE INDEX IF NOT EXISTS credential_dispatch_leases_user_state_idx
  ON credential_dispatch_leases (user_id, state, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS credential_dispatch_leases_id_decision_idx
  ON credential_dispatch_leases (id, decision_id);

CREATE TABLE IF NOT EXISTS execution_dispatch_ambiguities (
  dispatch_lease_id UUID PRIMARY KEY,
  decision_id UUID NOT NULL,
  explanation_id UUID NOT NULL,
  phase STRING NOT NULL,
  reason_code STRING NOT NULL,
  CONSTRAINT execution_dispatch_ambiguity_observation_pair_check CHECK (
    (phase = 'adapter_execute' AND reason_code IN (
      'adapter_result_unbound', 'adapter_exception'
    )) OR
    (phase = 'adapter_stream' AND reason_code IN (
      'stream_protocol_invalid', 'stream_incomplete', 'stream_exception'
    )) OR
    (phase = 'lease_expiry' AND reason_code IN ('lease_expired')) OR
    (phase = 'lease_recovery' AND reason_code IN ('legacy_ambiguous'))
  ),
  observation JSONB NOT NULL,
  evidence_schema_version INT NOT NULL DEFAULT 1 CHECK (evidence_schema_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT execution_dispatch_ambiguity_lease_fk
    FOREIGN KEY (dispatch_lease_id, decision_id)
    REFERENCES credential_dispatch_leases (id, decision_id) ON DELETE CASCADE,
  CONSTRAINT execution_dispatch_ambiguity_explanation_fk
    FOREIGN KEY (explanation_id, decision_id)
    REFERENCES explanation_records (id, decision_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS execution_dispatch_ambiguities_explanation_idx
  ON execution_dispatch_ambiguities (explanation_id);
