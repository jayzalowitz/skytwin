-- 035-dxt-imports.sql
-- DXT import tracking table for the explicit-confirm install flow (#180 follow-up).
-- Every imported DXT artifact is persisted here before install so the user
-- can review and confirm (or reject) in a separate step.
-- Paired with: apps/api/src/routes/dxt.ts (confirm/reject/list endpoints)

CREATE TABLE IF NOT EXISTS dxt_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  artifact_blob BYTES NOT NULL,
  artifact_sha256 BYTES NOT NULL,
  registry_id STRING NOT NULL,
  source_instance_id UUID,        -- from the DXT payload, if present
  status STRING NOT NULL CHECK (status IN ('pending', 'installed', 'rejected', 'failed')),
  installed_server_id UUID,       -- FK to mcp_servers if status = 'installed'
  rejected_at TIMESTAMPTZ,
  installed_at TIMESTAMPTZ,
  error_message STRING            -- only set if status = 'failed'
);

CREATE INDEX IF NOT EXISTS dxt_imports_user_idx
  ON dxt_imports (user_id, status, imported_at DESC);

-- Extend capability_provenance_nodes.node_type to include 'manual_install'
-- used when a DXT import is confirmed and installed by the user.
ALTER TABLE capability_provenance_nodes
  DROP CONSTRAINT IF EXISTS cpn_node_type_check;

ALTER TABLE capability_provenance_nodes
  ADD CONSTRAINT cpn_node_type_check CHECK (node_type IN (
    'signal', 'entity', 'suggestion', 'install', 'tier_promotion',
    'action', 'feedback', 'uninstall', 'external_agent', 'zero_trust_change',
    'manual_install'
  ));
