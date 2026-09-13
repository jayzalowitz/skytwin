-- Receipt emission can produce more than one row per explanation. Migration
-- 074 may already have run, so evolve it here rather than rewriting history.
-- CockroachDB represents UNIQUE constraints as backing indexes and does not
-- implement PostgreSQL's ALTER TABLE ... DROP CONSTRAINT form for them.
-- DROP INDEX is idempotent here and removes the uniqueness constraint on both
-- fresh installs and databases that already applied migration 074.
DROP INDEX IF EXISTS inference_receipts_decision_id_explanation_id_key CASCADE;

CREATE INDEX IF NOT EXISTS inference_receipts_explanation_idx
  ON inference_receipts (explanation_id, created_at ASC);

-- A separate completion marker distinguishes a fully finalized capture (even
-- when no provider call completed) from a crash between explanation creation
-- and receipt persistence. It participates in the same transaction as inserts.
CREATE TABLE IF NOT EXISTS inference_receipt_completions (
  decision_id UUID PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
  explanation_id UUID NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inference_receipt_completions_explanation_decision_fk
    FOREIGN KEY (explanation_id, decision_id)
    REFERENCES explanation_records (id, decision_id) ON DELETE CASCADE
);
