-- 036-lifebooks.sql
-- Emergent Lifebooks: detected life domains per user (#193 Child 1).
--
-- The domain-extractor worker (apps/worker/src/jobs/domain-extraction.ts)
-- runs runPrompt('domain-extraction', ...) against the user's MemPalace,
-- gets back 3-10 detected domains, and upserts a row here per domain.
-- Each row points at a MemPalace wing created by Palace.ensureWing().
--
-- Hidden rows still exist (so signal history survives) but are filtered
-- out of dashboards and per-domain suggestions. Re-running extraction
-- never resurrects a hidden row — only the user's explicit "show again"
-- can clear hidden_at.

CREATE TABLE IF NOT EXISTS lifebooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_name STRING NOT NULL,
  importance STRING NOT NULL CHECK (importance IN ('core', 'secondary', 'emerging')),
  sample_signals JSONB NOT NULL DEFAULT '[]',
  suggested_capabilities JSONB NOT NULL DEFAULT '[]',
  wing_id UUID,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at TIMESTAMPTZ,
  -- #321 importance-override ceremony. JSONB instead of a typed column
  -- so future per-Lifebook state lands without another migration.
  -- Added by migration 056.
  metadata JSONB NOT NULL DEFAULT '{}',
  UNIQUE (user_id, domain_name)
);

CREATE INDEX IF NOT EXISTS lifebooks_user_visible_idx
  ON lifebooks (user_id, importance, last_seen_at DESC)
  WHERE hidden_at IS NULL;

CREATE INDEX IF NOT EXISTS lifebooks_user_all_idx
  ON lifebooks (user_id, last_seen_at DESC);
