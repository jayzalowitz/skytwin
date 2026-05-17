-- 051-explanation-capability-provenance.sql
-- Wire the lineage view from action → explanation → provenance node (#305).
--
-- Background. `ExplanationRecord.capabilityProvenanceNodeId` was declared in
-- shared-types/src/explanation.ts but never wired into the persistence path
-- (parent epic #189 closed without finalizing it). Without the column, the
-- lineage view can't walk from an action's explanation back to the capability
-- provenance node it originated from — exactly the trail the user needs to
-- answer "which capability led to this?" for an MCP-mediated action.
--
-- This migration adds the column. Wiring through the explanation generator
-- and repository adapter lands in the same PR.
--
-- ON DELETE behavior: SET NULL. A capability provenance node could be
-- removed (uninstall ceremony, retention policy) without losing the
-- explanation history — the explanation row stays, just without the
-- backlink. Hard cascade-delete would silently shrink the audit trail.
--
-- Idempotency contract. Three statements, each guarded so the migration
-- runs cleanly on both fresh installs (bootstrap schema.sql has already
-- added the column with no FK) and existing installs (no column yet).
-- The FK is split out of the ADD COLUMN to keep both paths converging
-- on the same final shape — without the split, the ADD COLUMN IF NOT
-- EXISTS would skip on fresh installs and the FK would never land.

ALTER TABLE explanation_records
  ADD COLUMN IF NOT EXISTS capability_provenance_node_id UUID;

-- Split-out FK so fresh installs (column already created by schema.sql
-- without the REFERENCES clause) get the ON DELETE SET NULL behavior,
-- and existing installs (column just added above) get it too. The
-- constraint name is fixed so re-runs raise SQLSTATE 42710
-- (duplicate_object), which the migration runner swallows as one of its
-- idempotent-DDL codes — same shape used by other migrations.
ALTER TABLE explanation_records
  ADD CONSTRAINT explanation_records_capability_node_fk
  FOREIGN KEY (capability_provenance_node_id)
  REFERENCES capability_provenance_nodes(id) ON DELETE SET NULL;

-- Index for the lineage-view query: "find all explanations linked to this
-- capability node." Partial-style — only the non-null rows matter.
CREATE INDEX IF NOT EXISTS explanation_records_capability_node_idx
  ON explanation_records (capability_provenance_node_id)
  WHERE capability_provenance_node_id IS NOT NULL;
