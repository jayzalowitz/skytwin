-- Persist one immutable, explanation-linked observation when a request-start
-- lease cannot establish trustworthy terminal truth.  The observation is
-- separate from the mutable lease state so later out-of-band reconciliation
-- can record completed/failed without erasing that ambiguity occurred.

CREATE UNIQUE INDEX IF NOT EXISTS credential_dispatch_leases_id_decision_idx
  ON credential_dispatch_leases (id, decision_id);

CREATE TABLE IF NOT EXISTS execution_dispatch_ambiguities (
  dispatch_lease_id UUID PRIMARY KEY,
  decision_id UUID NOT NULL,
  explanation_id UUID NOT NULL,
  phase STRING NOT NULL CHECK (phase IN (
    'adapter_execute', 'adapter_stream', 'lease_expiry', 'lease_recovery'
  )),
  reason_code STRING NOT NULL CHECK (reason_code IN (
    'adapter_result_unbound', 'adapter_exception',
    'stream_protocol_invalid', 'stream_incomplete', 'stream_exception',
    'lease_expired', 'legacy_ambiguous'
  )),
  observation JSONB NOT NULL,
  evidence_schema_version INT NOT NULL DEFAULT 1 CHECK (evidence_schema_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT execution_dispatch_ambiguity_lease_fk
    FOREIGN KEY (dispatch_lease_id, decision_id)
    REFERENCES credential_dispatch_leases (id, decision_id) ON DELETE CASCADE,
  CONSTRAINT execution_dispatch_ambiguity_explanation_fk
    FOREIGN KEY (explanation_id, decision_id)
    REFERENCES explanation_records (id, decision_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_dispatch_ambiguities_explanation_idx
  ON execution_dispatch_ambiguities (explanation_id);
