-- #695: durable, owner-bound rollback admission and terminal ledger.
CREATE TABLE IF NOT EXISTS rollback_admissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  candidate_action_id UUID NOT NULL REFERENCES candidate_actions(id),
  decision_outcome_id UUID NOT NULL REFERENCES decision_outcomes(id),
  execution_result_id UUID NOT NULL REFERENCES execution_results(id),
  adapter_name STRING NOT NULL,
  provider_plan_id STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rollback_admission_one_claim_per_action UNIQUE (candidate_action_id),
  CONSTRAINT rollback_admission_owner_graph UNIQUE (id, user_id)
);

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
