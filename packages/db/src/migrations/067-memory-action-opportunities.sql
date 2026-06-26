-- 067-memory-action-opportunities.sql
-- Durable ledger for the memory action loop.
--
-- Daily briefings can suggest action opportunities from memory, but the
-- agentic loop needs state across days: whether an opportunity was already
-- suggested, whether SkyTwin tried to route it, whether policy queued an
-- approval, or whether it is waiting on an OpenClaw/IronClaw capability.

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
      'queued_approval',
      'auto_executed',
      'blocked_by_policy',
      'learning_needed',
      'execution_failed',
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS memory_action_opportunities_user_status_idx
  ON memory_action_opportunities (user_id, status, last_attempted_at, last_suggested_at DESC);

CREATE INDEX IF NOT EXISTS memory_action_opportunities_user_report_idx
  ON memory_action_opportunities (user_id, last_attempted_at DESC)
  WHERE last_attempted_at IS NOT NULL;
