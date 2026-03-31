-- Evaluation run history and accuracy metrics for continuous improvement tracking

CREATE TABLE IF NOT EXISTS eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id STRING NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  twin_version INT NOT NULL,
  total INT NOT NULL,
  passed INT NOT NULL,
  failed INT NOT NULL,
  pass_rate FLOAT NOT NULL,
  regressions STRING[] NOT NULL DEFAULT '{}',
  improvements STRING[] NOT NULL DEFAULT '{}',
  full_report JSONB NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id, suite_id, run_at DESC)
);

CREATE TABLE IF NOT EXISTS accuracy_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  domain STRING NOT NULL,
  total_decisions INT NOT NULL DEFAULT 0,
  auto_executed INT NOT NULL DEFAULT 0,
  approved_by_user INT NOT NULL DEFAULT 0,
  rejected_by_user INT NOT NULL DEFAULT 0,
  corrected_by_user INT NOT NULL DEFAULT 0,
  accuracy_rate FLOAT NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id, domain, period_start DESC)
);
