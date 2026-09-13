-- Durable one-shot admission for effect-bearing memory and approval execution.
-- `in_progress` and `ambiguous` are both non-replay states: current adapters do
-- not provide a server-enforced idempotency protocol.
CREATE UNIQUE INDEX IF NOT EXISTS decisions_id_user_idx
  ON decisions (id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_actions_id_decision_idx
  ON candidate_actions (id, decision_id);
CREATE UNIQUE INDEX IF NOT EXISTS decision_outcomes_id_decision_action_idx
  ON decision_outcomes (id, decision_id, selected_action_id);
CREATE UNIQUE INDEX IF NOT EXISTS execution_plans_id_decision_action_idx
  ON execution_plans (id, decision_id, action_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS execution_authority_revision UUID NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE IF NOT EXISTS execution_policy_authority (
  singleton BOOL PRIMARY KEY DEFAULT true CHECK (singleton),
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO execution_policy_authority (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

-- Known-owner OAuth redirects bind the per-user provider epoch. Account-unknown
-- sign-in redirects use a DB-issued pending row and the resolved account
-- tombstone below, avoiding a cross-tenant provider-wide invalidation switch.
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

-- A credential row carries two independent generations. credential_revision
-- changes with the OAuth grant; dispatch_generation also changes when a
-- disconnect begins, fencing new request-start leases before remote revoke.
ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS credential_revision UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS dispatch_generation UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS dispatch_state STRING NOT NULL DEFAULT 'active'
    CHECK (dispatch_state IN ('active', 'disconnecting'));

-- The committed request_started row is the external-request linearization
-- point. It contains identities and hashes only; OAuth secrets and the random
-- bearer capability never enter durable storage.
CREATE TABLE IF NOT EXISTS credential_dispatch_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  oauth_token_id UUID NOT NULL,
  provider STRING NOT NULL,
  account_email STRING NOT NULL,
  credential_revision UUID NOT NULL,
  credential_generation UUID NOT NULL,
  vault_generation UUID,
  policy_authority_revision UUID NOT NULL,
  action_id UUID NOT NULL,
  decision_id UUID NOT NULL,
  execution_plan_id UUID NOT NULL,
  authority_kind STRING NOT NULL CHECK (authority_kind IN ('admission', 'receipt')),
  authority_id UUID NOT NULL,
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

ALTER TABLE user_credential_vault_meta
  ADD COLUMN IF NOT EXISTS vault_state STRING NOT NULL DEFAULT 'locked'
    CHECK (vault_state IN ('locked', 'unlocked'));
ALTER TABLE user_credential_vault_meta
  ADD COLUMN IF NOT EXISTS vault_generation UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE credential_dispatch_leases
  ADD COLUMN IF NOT EXISTS vault_generation UUID;
ALTER TABLE credential_dispatch_leases
  ADD COLUMN IF NOT EXISTS policy_authority_revision UUID NOT NULL DEFAULT gen_random_uuid();

-- Version durable execution evidence so the rerunnable migration runner can
-- scrub legacy arbitrary bodies exactly once without touching new typed rows.
ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS evidence_schema_version INT NOT NULL DEFAULT 0;
ALTER TABLE execution_results ADD COLUMN IF NOT EXISTS evidence_schema_version INT NOT NULL DEFAULT 0;
ALTER TABLE execution_events ADD COLUMN IF NOT EXISTS evidence_schema_version INT NOT NULL DEFAULT 0;
ALTER TABLE memory_action_opportunities ADD COLUMN IF NOT EXISTS evidence_schema_version INT NOT NULL DEFAULT 0;
ALTER TABLE execution_admission_barriers ADD COLUMN IF NOT EXISTS evidence_schema_version INT NOT NULL DEFAULT 0;

UPDATE execution_plans
   SET steps = '[]'::JSONB, evidence_schema_version = 1
 WHERE evidence_schema_version < 1;
UPDATE execution_results
   SET outputs = '{"_redacted":"[redacted:unapproved-evidence]"}'::JSONB,
       error = CASE WHEN error IS NULL THEN NULL ELSE '[redacted:execution-error]' END,
       evidence_schema_version = 1
 WHERE evidence_schema_version < 1;
UPDATE execution_events
   SET payload = '{"_redacted":"[redacted:unapproved-evidence]"}'::JSONB,
       step_id = NULL,
       event_type = CASE
         WHEN event_type IN ('plan_started', 'step_started', 'step_completed',
                             'step_failed', 'plan_completed', 'plan_failed')
           THEN event_type
         ELSE 'unknown'
       END,
       evidence_schema_version = 1
 WHERE evidence_schema_version < 1;
UPDATE memory_action_opportunities
   SET title = '[redacted:unapproved-evidence]',
       reason = '[redacted:unapproved-evidence]',
       suggested_action = '[redacted:unapproved-evidence]',
       action_type = 'unknown',
       action_label = '[redacted:unapproved-evidence]',
       action_plan = '{"actionType":"unknown","label":"[redacted:unapproved-evidence]","primaryAdapter":"openclaw","fallbackAdapters":[],"readiness":"learn_or_connect","learnTarget":"unknown","runtimeVersion":{"runtime":"openclaw","displayName":"OpenClaw","stableVersion":"unknown","stableUrl":"https://openclaw.ai","checkedAt":"1970-01-01"},"adapterRationale":"[redacted:unapproved-evidence]"}'::JSONB,
       source_refs = ARRAY[]::STRING[], memory_refs = ARRAY[]::STRING[], source_types = ARRAY[]::STRING[],
       last_report = NULL, adapter_name = NULL, policy_reason = NULL, route_reason = NULL, next_step = NULL,
       evidence_schema_version = 1
 WHERE evidence_schema_version < 1;
UPDATE execution_admission_barriers
   SET observed_result = CASE
         WHEN status = 'in_progress' THEN '{}'::JSONB
         ELSE jsonb_build_object(
           'planId', execution_plan_id::STRING,
           'status', status,
           'output', jsonb_build_object('_redacted', '[redacted:unapproved-evidence]'),
           'error', NULL,
           '_redacted', '[redacted:unapproved-evidence]'
         )
       END,
       evidence_schema_version = 1
 WHERE evidence_schema_version < 1;

-- After legacy rows are scrubbed, omitted values represent newly authored
-- evidence and must use the same typed default as a fresh schema install.
ALTER TABLE execution_plans ALTER COLUMN evidence_schema_version SET DEFAULT 1;
ALTER TABLE execution_results ALTER COLUMN evidence_schema_version SET DEFAULT 1;
ALTER TABLE execution_events ALTER COLUMN evidence_schema_version SET DEFAULT 1;
ALTER TABLE memory_action_opportunities ALTER COLUMN evidence_schema_version SET DEFAULT 1;
ALTER TABLE execution_admission_barriers ALTER COLUMN evidence_schema_version SET DEFAULT 1;
