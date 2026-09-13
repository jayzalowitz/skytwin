-- A receipt completion proves that inference evidence is durable, but it does
-- not say whether an autonomous effect was claimed. Keep that second piece of
-- authority in its own one-row-per-decision guard so retries can resume safe
-- approval/non-effect work without ever dispatching an ambiguous effect twice.
CREATE TABLE IF NOT EXISTS decision_ingest_guards (
  decision_id UUID PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
  receipt_explanation_id UUID,
  continuation_kind STRING NOT NULL,
  confirmation_level STRING,
  effect_state STRING NOT NULL,
  source_effect_state STRING,
  source_execution_status STRING,
  source_execution_plan_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_ingest_guards_effect_state_check CHECK (
    effect_state IN ('non_effect', 'ready', 'running', 'completed', 'failed', 'restored_non_replay')
  ),
  CONSTRAINT decision_ingest_guards_continuation_kind_check CHECK (
    continuation_kind IN ('auto_execute', 'approval', 'non_effect')
  ),
  CONSTRAINT decision_ingest_guards_confirmation_level_check CHECK (
    (continuation_kind = 'approval' AND confirmation_level IS NOT NULL AND
      confirmation_level IN ('single', 'dual')) OR
    (continuation_kind != 'approval' AND confirmation_level IS NULL)
  ),
  CONSTRAINT decision_ingest_guards_source_effect_state_check CHECK (
    source_effect_state IS NULL OR
    source_effect_state IN ('non_effect', 'ready', 'running', 'completed', 'failed', 'restored_non_replay')
  ),
  CONSTRAINT decision_ingest_guards_source_execution_status_check CHECK (
    source_execution_status IS NULL OR source_execution_status IN ('completed', 'failed', 'ambiguous')
  ),
  CONSTRAINT decision_ingest_guards_receipt_explanation_fk
    FOREIGN KEY (receipt_explanation_id, decision_id)
    REFERENCES explanation_records (id, decision_id) ON DELETE CASCADE
);

-- Existing completions predate an effect claim. A terminal result is safe to
-- classify exactly; an auto-execute outcome without one is permanently
-- ambiguous and must never be replayed automatically.
INSERT INTO decision_ingest_guards (
  decision_id,
  receipt_explanation_id,
  continuation_kind,
  confirmation_level,
  effect_state,
  source_execution_status,
  source_execution_plan_id,
  created_at,
  updated_at
)
SELECT
  c.decision_id,
  c.explanation_id,
  CASE
    WHEN o.requires_approval IS TRUE THEN 'approval'
    WHEN o.auto_executed IS TRUE THEN 'auto_execute'
    ELSE 'non_effect'
  END,
  CASE WHEN o.requires_approval IS TRUE THEN 'dual' ELSE NULL END,
  CASE
    WHEN o.auto_executed IS NOT TRUE THEN 'non_effect'
    WHEN latest.result_success IS TRUE THEN 'completed'
    WHEN latest.result_success IS FALSE THEN 'failed'
    ELSE 'restored_non_replay'
  END,
  CASE
    WHEN latest.result_success IS TRUE THEN 'completed'
    WHEN latest.result_success IS FALSE THEN 'failed'
    WHEN o.auto_executed IS TRUE THEN 'ambiguous'
    ELSE NULL
  END,
  latest.plan_id,
  c.completed_at,
  now()
FROM inference_receipt_completions c
LEFT JOIN decision_outcomes o ON o.decision_id = c.decision_id
LEFT JOIN LATERAL (
  SELECT ep.id AS plan_id, er.success AS result_success
  FROM execution_plans ep
  LEFT JOIN execution_results er ON er.plan_id = ep.id
  WHERE ep.decision_id = c.decision_id
  ORDER BY ep.created_at DESC, er.completed_at DESC
  LIMIT 1
) latest ON true
ON CONFLICT (decision_id) DO NOTHING;
