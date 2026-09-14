-- Versioned, structured reasoning-path receipts. Ownership is derived from
-- the linked decision; there is intentionally no caller-writable user_id.
CREATE UNIQUE INDEX IF NOT EXISTS explanation_records_id_decision_idx
  ON explanation_records (id, decision_id);

CREATE TABLE IF NOT EXISTS inference_receipts (
  id UUID PRIMARY KEY,
  version INT NOT NULL,
  decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  explanation_id UUID NOT NULL,
  status STRING NOT NULL,
  receipt JSONB NOT NULL,
  trusted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inference_receipts_version_chk CHECK (version = 1),
  CONSTRAINT inference_receipts_status_chk CHECK (status IN (
    'on_device', 'verified', 'conventional', 'verification_failed',
    'verification_unavailable', 'verification_stale', 'local_fallback'
  )),
  UNIQUE (decision_id),
  CONSTRAINT inference_receipts_explanation_decision_fk
    FOREIGN KEY (explanation_id, decision_id)
    REFERENCES explanation_records (id, decision_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS inference_receipts_decision_idx
  ON inference_receipts (decision_id, created_at DESC);
