-- Durable admission record for externally visible effects (#653).
-- An in-progress row is never automatically reclaimed: current adapters do
-- not accept idempotency keys, so a crash during a call has an unknown result.
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
  UNIQUE (user_id, effect_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS pre_effect_barriers_decision_idx
  ON pre_effect_barriers (decision_id)
  WHERE decision_id IS NOT NULL;

-- Reserved is the only intentionally explanation-free state. Every prepared,
-- claimed, or terminal barrier must retain its durable audit record.
ALTER TABLE pre_effect_barriers DROP CONSTRAINT IF EXISTS pre_effect_barrier_explanation_required;
ALTER TABLE pre_effect_barriers ADD CONSTRAINT pre_effect_barrier_explanation_required
  CHECK (status = 'reserved' OR explanation_id IS NOT NULL);

-- An interrupted adapter call is distinct from a known failed result. Both are
-- terminal because adapters cannot deduplicate a replay, but `unknown` tells an
-- operator to reconcile remote state before taking any further action.
ALTER TABLE memory_action_opportunities DROP CONSTRAINT IF EXISTS check_status;
ALTER TABLE memory_action_opportunities ADD CONSTRAINT check_status CHECK (status IN (
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
));
