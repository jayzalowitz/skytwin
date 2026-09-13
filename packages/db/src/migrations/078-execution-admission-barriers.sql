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
  status STRING NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'failed', 'ambiguous')),
  observed_result JSONB NOT NULL DEFAULT '{}'::JSONB,
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
