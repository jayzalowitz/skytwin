-- Phase 1: Foundation migrations for scope expansion (CEO Review 2026-04-01)
-- New tables: signals, preference_proposals, twin_exports, skill_gap_log, proactive_scans, briefings
-- Column additions: decisions.source, execution_results.adapter_used, explanation_records.type,
--                   feedback_events.undo_reasoning, feedback_events.undo_step_id

-- ============================================================================
-- New Tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  source STRING NOT NULL,
  type STRING NOT NULL,
  domain STRING NOT NULL,
  data JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_signals_user_domain_ts (user_id, domain, timestamp DESC),
  INDEX idx_signals_retention (retention_until)
);

CREATE TABLE IF NOT EXISTS preference_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  domain STRING NOT NULL,
  key STRING NOT NULL,
  value JSONB NOT NULL,
  confidence STRING NOT NULL,
  supporting_evidence JSONB NOT NULL DEFAULT '[]',
  status STRING NOT NULL DEFAULT 'pending',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_proposals_user_status (user_id, status)
);

CREATE TABLE IF NOT EXISTS twin_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  format STRING NOT NULL,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_twin_exports_user (user_id)
);

CREATE TABLE IF NOT EXISTS skill_gap_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type STRING NOT NULL,
  action_description STRING NOT NULL,
  attempted_adapters JSONB NOT NULL DEFAULT '[]',
  user_id UUID NOT NULL REFERENCES users(id),
  decision_id UUID REFERENCES decisions(id),
  ironclaw_issue_url STRING,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_skill_gaps_action (action_type),
  INDEX idx_skill_gaps_decision (decision_id),
  INDEX idx_skill_gaps_user (user_id)
);

CREATE TABLE IF NOT EXISTS proactive_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  scan_type STRING NOT NULL,
  items_found INT NOT NULL DEFAULT 0,
  items_auto_executed INT NOT NULL DEFAULT 0,
  items_queued_approval INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  INDEX idx_scans_user (user_id, started_at DESC)
);

CREATE TABLE IF NOT EXISTS briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  scan_id UUID REFERENCES proactive_scans(id),
  items JSONB NOT NULL DEFAULT '[]',
  email_sent BOOL NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_briefings_user (user_id, created_at DESC),
  INDEX idx_briefings_scan (scan_id)
);

-- ============================================================================
-- Column Additions (safe for existing tables)
-- Single-statement ADD COLUMN with DEFAULT + NOT NULL avoids CockroachDB
-- async schema-change conflicts (the 3-step ALTER→UPDATE→ALTER pattern
-- fails because the column isn't visible until the backfill job completes).
-- ============================================================================

-- decisions.source
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS source STRING NOT NULL DEFAULT 'reactive';

-- execution_results.adapter_used (nullable, no backfill needed)
ALTER TABLE execution_results ADD COLUMN IF NOT EXISTS adapter_used STRING;

-- explanation_records.type
ALTER TABLE explanation_records ADD COLUMN IF NOT EXISTS type STRING NOT NULL DEFAULT 'action';

-- feedback_events.undo_reasoning (nullable JSONB, no constraint needed)
ALTER TABLE feedback_events ADD COLUMN IF NOT EXISTS undo_reasoning JSONB;

-- feedback_events.undo_step_id (nullable, no constraint needed)
ALTER TABLE feedback_events ADD COLUMN IF NOT EXISTS undo_step_id STRING;
