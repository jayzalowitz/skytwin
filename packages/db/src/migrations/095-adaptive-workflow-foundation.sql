-- Immutable adaptive-workflow identity, versions, review proposals, and
-- append-only activation history (#753). Runtime/Watch projection is separate.

CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_key STRING NOT NULL CHECK (
    provider_key ~ '^[a-z][a-z0-9_.-]{0,127}$'
  ),
  active_version_id UUID,
  active_activation_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workflows_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT workflows_id_user_provider_unique UNIQUE (id, user_id, provider_key),
  CONSTRAINT workflows_active_pointer_shape CHECK (
    (active_version_id IS NULL AND active_activation_event_id IS NULL)
    OR (active_version_id IS NOT NULL AND active_activation_event_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS workflows_user_created_idx
  ON workflows (user_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL,
  user_id UUID NOT NULL,
  version_number INT NOT NULL CHECK (version_number > 0),
  provider_key STRING NOT NULL CHECK (
    provider_key ~ '^[a-z][a-z0-9_.-]{0,127}$'
  ),
  provider_schema_version STRING NOT NULL CHECK (
    provider_schema_version ~ '^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$'
  ),
  canonical_payload JSONB NOT NULL CHECK (jsonb_typeof(canonical_payload) = 'object'),
  content_hash STRING NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  parent_version_id UUID,
  authoring_metadata JSONB NOT NULL CHECK (jsonb_typeof(authoring_metadata) = 'object'),
  inference_metadata JSONB CHECK (
    inference_metadata IS NULL OR jsonb_typeof(inference_metadata) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workflow_versions_number_unique UNIQUE (workflow_id, version_number),
  CONSTRAINT workflow_versions_id_workflow_user_unique UNIQUE (id, workflow_id, user_id),
  CONSTRAINT workflow_versions_id_workflow_user_provider_unique
    UNIQUE (id, workflow_id, user_id, provider_key),
  CONSTRAINT workflow_versions_workflow_owner_provider_fk
    FOREIGN KEY (workflow_id, user_id, provider_key)
    REFERENCES workflows (id, user_id, provider_key) ON DELETE CASCADE,
  CONSTRAINT workflow_versions_parent_owner_fk
    FOREIGN KEY (parent_version_id, workflow_id, user_id)
    REFERENCES workflow_versions (id, workflow_id, user_id),
  CONSTRAINT workflow_versions_parent_shape CHECK (
    (version_number = 1 AND parent_version_id IS NULL)
    OR (version_number > 1 AND parent_version_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS workflow_versions_workflow_created_idx
  ON workflow_versions (workflow_id, version_number DESC);

ALTER TABLE workflows ADD CONSTRAINT workflows_active_version_owner_provider_fk
  FOREIGN KEY (active_version_id, id, user_id, provider_key)
  REFERENCES workflow_versions (id, workflow_id, user_id, provider_key);

CREATE TABLE IF NOT EXISTS workflow_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL,
  user_id UUID NOT NULL,
  base_version_id UUID,
  proposed_version_id UUID NOT NULL,
  kind STRING NOT NULL CHECK (kind IN ('initial', 'edit', 'feedback', 'import')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workflow_proposals_version_unique UNIQUE (workflow_id, proposed_version_id),
  CONSTRAINT workflow_proposals_id_workflow_user_version_unique
    UNIQUE (id, workflow_id, user_id, proposed_version_id),
  CONSTRAINT workflow_proposals_workflow_owner_fk
    FOREIGN KEY (workflow_id, user_id)
    REFERENCES workflows (id, user_id) ON DELETE CASCADE,
  CONSTRAINT workflow_proposals_base_owner_fk
    FOREIGN KEY (base_version_id, workflow_id, user_id)
    REFERENCES workflow_versions (id, workflow_id, user_id),
  CONSTRAINT workflow_proposals_version_owner_fk
    FOREIGN KEY (proposed_version_id, workflow_id, user_id)
    REFERENCES workflow_versions (id, workflow_id, user_id),
  CONSTRAINT workflow_proposals_distinct_versions CHECK (
    base_version_id IS NULL OR base_version_id <> proposed_version_id
  ),
  CONSTRAINT workflow_proposals_kind_base_shape CHECK (
    (kind IN ('initial', 'import') AND base_version_id IS NULL)
    OR (kind IN ('edit', 'feedback') AND base_version_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS workflow_proposals_user_created_idx
  ON workflow_proposals (user_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS workflow_activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL,
  user_id UUID NOT NULL,
  previous_version_id UUID,
  activated_version_id UUID NOT NULL,
  proposal_id UUID,
  kind STRING NOT NULL CHECK (kind IN ('activate', 'rollback')),
  event_sequence INT NOT NULL CHECK (event_sequence > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workflow_activation_events_id_owner_unique
    UNIQUE (id, workflow_id, user_id),
  CONSTRAINT workflow_activation_events_active_pointer_unique
    UNIQUE (id, workflow_id, user_id, activated_version_id),
  CONSTRAINT workflow_activation_events_sequence_unique
    UNIQUE (workflow_id, event_sequence),
  CONSTRAINT workflow_activation_events_workflow_owner_fk
    FOREIGN KEY (workflow_id, user_id)
    REFERENCES workflows (id, user_id) ON DELETE CASCADE,
  CONSTRAINT workflow_activation_events_previous_owner_fk
    FOREIGN KEY (previous_version_id, workflow_id, user_id)
    REFERENCES workflow_versions (id, workflow_id, user_id),
  CONSTRAINT workflow_activation_events_version_owner_fk
    FOREIGN KEY (activated_version_id, workflow_id, user_id)
    REFERENCES workflow_versions (id, workflow_id, user_id),
  CONSTRAINT workflow_activation_events_proposal_owner_version_fk
    FOREIGN KEY (proposal_id, workflow_id, user_id, activated_version_id)
    REFERENCES workflow_proposals (id, workflow_id, user_id, proposed_version_id),
  CONSTRAINT workflow_activation_events_transition_shape CHECK (
    (kind = 'activate' AND proposal_id IS NOT NULL
      AND (previous_version_id IS NULL OR previous_version_id <> activated_version_id))
    OR (kind = 'rollback' AND previous_version_id IS NOT NULL
      AND previous_version_id <> activated_version_id AND proposal_id IS NULL)
  )
);

ALTER TABLE workflows ADD CONSTRAINT workflows_active_event_owner_fk
  FOREIGN KEY (active_activation_event_id, id, user_id, active_version_id)
  REFERENCES workflow_activation_events (
    id, workflow_id, user_id, activated_version_id
  );

CREATE INDEX IF NOT EXISTS workflow_activation_events_workflow_created_idx
  ON workflow_activation_events (workflow_id, created_at DESC, id);

-- A reviewed proposal is a one-shot capability. Rollback never makes its
-- original activation proposal reusable.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_activation_events_proposal_once_idx
  ON workflow_activation_events (proposal_id) WHERE proposal_id IS NOT NULL;
