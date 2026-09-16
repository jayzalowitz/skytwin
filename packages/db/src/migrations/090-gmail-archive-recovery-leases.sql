-- Operational, owner-bound recovery fencing for abandoned Gmail archive work.
-- Lease rows are installation-local coordination state and never portable
-- evidence. The referenced barrier remains the durable authority/grace anchor.

CREATE UNIQUE INDEX IF NOT EXISTS pre_effect_barriers_id_user_key
  ON pre_effect_barriers (id, user_id);

CREATE TABLE IF NOT EXISTS gmail_archive_recovery_leases (
  admission_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  approval_id UUID NOT NULL,
  message_ref_id UUID NOT NULL,
  work_kind STRING NOT NULL CHECK (work_kind IN (
    'resume_preparation', 'resume_claim', 'reconcile_pre_dispatch', 'observe_dispatch'
  )),
  barrier_status STRING NOT NULL CHECK (barrier_status IN (
    'reserved', 'prepared', 'in_progress'
  )),
  attempt_phase STRING CHECK (attempt_phase IN (
    'pre_dispatch', 'dispatch_may_have_started'
  )),
  phase_changed_at TIMESTAMPTZ NOT NULL,
  lease_token UUID NOT NULL,
  generation INT8 NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  observation_state STRING NOT NULL DEFAULT 'not_started' CHECK (observation_state IN (
    'not_started', 'started', 'evidence_recorded'
  )),
  observation_attempt_id UUID,
  observation_authorized_at TIMESTAMPTZ,
  observation_deadline_at TIMESTAMPTZ,
  observation_evidence JSONB,
  CONSTRAINT gmail_archive_recovery_lease_barrier_fk
    FOREIGN KEY (admission_id, user_id)
    REFERENCES pre_effect_barriers (id, user_id) ON DELETE CASCADE,
  CONSTRAINT gmail_archive_recovery_lease_owner_key UNIQUE (
    admission_id, user_id, approval_id
  ),
  CONSTRAINT gmail_archive_recovery_lease_time_chk CHECK (
    acquired_at <= renewed_at AND renewed_at <= expires_at
  ),
  CONSTRAINT gmail_archive_recovery_lease_stage_chk CHECK (
    (work_kind = 'resume_preparation' AND barrier_status = 'reserved' AND attempt_phase IS NULL) OR
    (work_kind = 'resume_claim' AND barrier_status = 'prepared' AND attempt_phase IS NULL) OR
    (work_kind = 'reconcile_pre_dispatch' AND barrier_status = 'in_progress' AND
      attempt_phase = 'pre_dispatch') OR
    (work_kind = 'observe_dispatch' AND barrier_status = 'in_progress' AND
      attempt_phase = 'dispatch_may_have_started')
  ),
  CONSTRAINT gmail_archive_recovery_lease_observation_chk CHECK (
    (work_kind <> 'observe_dispatch' AND observation_state = 'not_started' AND
      observation_attempt_id IS NULL AND observation_authorized_at IS NULL AND
      observation_deadline_at IS NULL AND observation_evidence IS NULL) OR
    (work_kind = 'observe_dispatch' AND observation_state = 'not_started' AND
      observation_attempt_id IS NULL AND observation_authorized_at IS NULL AND
      observation_deadline_at IS NULL AND observation_evidence IS NULL) OR
    (work_kind = 'observe_dispatch' AND observation_state = 'started' AND
      observation_attempt_id IS NOT NULL AND observation_authorized_at IS NOT NULL AND
      observation_deadline_at IS NOT NULL AND
      observation_authorized_at <= observation_deadline_at AND observation_evidence IS NULL) OR
    (work_kind = 'observe_dispatch' AND observation_state = 'evidence_recorded' AND
      observation_attempt_id IS NOT NULL AND observation_authorized_at IS NOT NULL AND
      observation_deadline_at IS NOT NULL AND
      observation_authorized_at <= observation_deadline_at AND observation_evidence IS NOT NULL AND
      jsonb_typeof(observation_evidence) = 'object')
  )
);

CREATE INDEX IF NOT EXISTS gmail_archive_recovery_leases_expiry_idx
  ON gmail_archive_recovery_leases (expires_at, admission_id);
