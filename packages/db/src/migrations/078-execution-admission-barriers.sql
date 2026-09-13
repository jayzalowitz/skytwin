-- Durable one-shot admission for effect-bearing memory and approval execution.
-- `in_progress` and `ambiguous` are both non-replay states: current adapters do
-- not provide a server-enforced idempotency protocol.
CREATE TABLE IF NOT EXISTS execution_admission_barriers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope STRING NOT NULL CHECK (scope IN ('memory', 'approval')),
  idempotency_key UUID NOT NULL,
  decision_id UUID NOT NULL REFERENCES decisions(id),
  action_id UUID NOT NULL REFERENCES candidate_actions(id),
  execution_plan_id UUID NOT NULL REFERENCES execution_plans(id),
  status STRING NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'failed', 'ambiguous')),
  observed_result JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS execution_admission_barriers_plan_idx
  ON execution_admission_barriers (execution_plan_id);
