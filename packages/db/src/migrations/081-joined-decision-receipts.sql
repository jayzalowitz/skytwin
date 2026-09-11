-- Repository-enforced, hash-linked metadata-only joined decision receipts (#657).
CREATE UNIQUE INDEX IF NOT EXISTS decisions_id_user_id_idx
  ON decisions (id, user_id);

CREATE TABLE IF NOT EXISTS decision_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_receipts_owned_decision_unique UNIQUE (decision_id),
  CONSTRAINT decision_receipts_owned_decision_fk
    FOREIGN KEY (decision_id, user_id) REFERENCES decisions (id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS decision_receipts_user_created_idx
  ON decision_receipts (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_receipt_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES decision_receipts(id) ON DELETE CASCADE,
  sequence INT NOT NULL CHECK (sequence > 0),
  event_key STRING NOT NULL CHECK (
    event_key ~ '^[a-z][a-z0-9_]{0,47}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  previous_digest STRING,
  content_digest STRING NOT NULL,
  revision_digest STRING NOT NULL,
  stage STRING NOT NULL CHECK (stage IN (
    'decision_recorded', 'policy_evaluated', 'approval_recorded',
    'execution_admitted', 'execution_recorded', 'feedback_recorded', 'corrected'
  )),
  disposition STRING NOT NULL CHECK (disposition IN (
    'pending', 'allowed', 'deliberate_non_action', 'requires_approval', 'approved',
    'rejected', 'expired', 'blocked', 'succeeded', 'failed', 'unknown', 'corrected'
  )),
  content JSONB NOT NULL,
  trusted BOOL NOT NULL DEFAULT false,
  -- Historical pointers are owner-derived and verified by the repository at
  -- append time, but intentionally are not FKs: deleting a source artifact
  -- must not mutate or strand the retained hash-linked receipt history.
  candidate_action_id UUID,
  barrier_id UUID,
  explanation_id UUID,
  approval_request_id UUID,
  execution_plan_id UUID,
  execution_result_id UUID,
  execution_disposition STRING CHECK (execution_disposition IN ('succeeded', 'failed', 'unknown')),
  correction_of_revision_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_receipt_revision_sequence_unique UNIQUE (receipt_id, sequence),
  CONSTRAINT decision_receipt_revision_event_unique UNIQUE (receipt_id, event_key),
  CONSTRAINT decision_receipt_previous_digest_shape CHECK (
    previous_digest IS NULL OR previous_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT decision_receipt_content_digest_shape CHECK (
    content_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT decision_receipt_revision_digest_shape CHECK (
    revision_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT decision_receipt_execution_result_plan CHECK (
    execution_result_id IS NULL OR execution_plan_id IS NOT NULL
  ),
  CONSTRAINT decision_receipt_execution_disposition_shape CHECK (
    (stage = 'execution_recorded' AND execution_disposition = disposition) OR
    (stage IN ('feedback_recorded', 'corrected') AND
      ((execution_plan_id IS NULL AND execution_disposition IS NULL) OR
       (execution_plan_id IS NOT NULL AND execution_disposition IS NOT NULL))) OR
    (stage NOT IN ('execution_recorded', 'feedback_recorded', 'corrected') AND
      execution_disposition IS NULL)
  ),
  CONSTRAINT decision_receipt_correction_shape CHECK (
    (stage = 'corrected' AND disposition = 'corrected' AND correction_of_revision_id IS NOT NULL)
    OR (stage != 'corrected' AND disposition != 'corrected' AND correction_of_revision_id IS NULL)
  ),
  CONSTRAINT decision_receipt_approval_shape CHECK (
    stage != 'approval_recorded' OR approval_request_id IS NOT NULL
  ),
  CONSTRAINT decision_receipt_execution_shape CHECK (
    stage != 'execution_recorded' OR (
      barrier_id IS NOT NULL AND disposition IN ('succeeded', 'failed', 'unknown')
      AND ((disposition IN ('succeeded', 'failed') AND execution_result_id IS NOT NULL)
        OR disposition = 'unknown')
    )
  ),
  CONSTRAINT decision_receipt_stage_disposition_matrix CHECK (
    (stage = 'decision_recorded' AND disposition = 'pending') OR
    (stage = 'policy_evaluated' AND disposition IN ('allowed', 'deliberate_non_action', 'requires_approval', 'blocked')) OR
    (stage = 'approval_recorded' AND disposition IN ('requires_approval', 'approved', 'rejected', 'expired')) OR
    (stage = 'execution_admitted' AND disposition = 'pending') OR
    (stage = 'execution_recorded' AND disposition IN ('succeeded', 'failed', 'unknown')) OR
    (stage = 'feedback_recorded' AND disposition IN (
      'deliberate_non_action', 'approved', 'rejected', 'expired', 'blocked', 'succeeded', 'failed', 'unknown'
    )) OR
    (stage = 'corrected' AND disposition = 'corrected')
  )
);

CREATE INDEX IF NOT EXISTS decision_receipt_revisions_receipt_created_idx
  ON decision_receipt_revisions (receipt_id, sequence DESC);
