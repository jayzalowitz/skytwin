# Issue 018: Phase 1 Foundation Migrations

**Status:** Not started
**Milestone:** Phase 1
**Estimate:** 0.5 day (human) / 10 min (CC)
**Depends on:** M0 complete (it is)
**CEO Review:** Unblocks all Phase 2+ work

## Goal

Run all database schema changes needed by the expanded scope. One migration file, all changes atomic.

## Schema Changes

### New Tables

**signals**
```sql
CREATE TABLE signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  domain TEXT NOT NULL,
  data JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_signals_user_domain_ts (user_id, domain, timestamp DESC),
  INDEX idx_signals_retention (retention_until)
);
```

**preference_proposals**
```sql
CREATE TABLE preference_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  domain TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  confidence TEXT NOT NULL,
  supporting_evidence JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_proposals_user_status (user_id, status)
);
```

**twin_exports**
```sql
CREATE TABLE twin_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  format TEXT NOT NULL CHECK (format IN ('json', 'markdown')),
  exported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**skill_gap_log**
```sql
CREATE TABLE skill_gap_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL,
  action_description TEXT NOT NULL,
  attempted_adapters JSONB NOT NULL DEFAULT '[]',
  user_id UUID NOT NULL REFERENCES users(id),
  decision_id UUID REFERENCES decisions(id),
  ironclaw_issue_url TEXT,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_skill_gaps_action (action_type)
);
```

**proactive_scans**
```sql
CREATE TABLE proactive_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  scan_type TEXT NOT NULL CHECK (scan_type IN ('daily', 'hourly', 'manual')),
  items_found INT NOT NULL DEFAULT 0,
  items_auto_executed INT NOT NULL DEFAULT 0,
  items_queued_approval INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  INDEX idx_scans_user (user_id, started_at DESC)
);
```

**briefings**
```sql
CREATE TABLE briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  scan_id UUID REFERENCES proactive_scans(id),
  items JSONB NOT NULL DEFAULT '[]',
  email_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_briefings_user (user_id, created_at DESC)
);
```

### Column Additions
```sql
ALTER TABLE decisions ADD COLUMN source TEXT NOT NULL DEFAULT 'reactive'
  CHECK (source IN ('reactive', 'proactive', 'query'));

ALTER TABLE execution_results ADD COLUMN adapter_used TEXT
  CHECK (adapter_used IN ('ironclaw', 'openclaw', 'direct'));

ALTER TABLE explanation_records ADD COLUMN type TEXT NOT NULL DEFAULT 'action'
  CHECK (type IN ('action', 'prediction'));

ALTER TABLE feedback_events ADD COLUMN undo_reasoning JSONB;
ALTER TABLE feedback_events ADD COLUMN undo_step_id TEXT;
-- Also need to add 'undo' to any feedbackType check constraint if one exists
```

## Success Criteria
1. Migration runs cleanly on fresh and existing databases
2. All new tables created with correct indexes
3. All column additions applied
4. Down migration drops everything cleanly
5. Existing data unaffected
