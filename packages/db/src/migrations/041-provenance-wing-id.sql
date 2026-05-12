-- 041-provenance-wing-id.sql
-- #193 follow-up: tie provenance nodes to a Lifebook wing.
--
-- The lifebook page (apps/web/public/js/pages/lifebook.js) already links to
-- `#/provenance?wing=<wingId>`, but the provenance page couldn't honor that
-- filter because nodes had no wing linkage. This migration adds a nullable
-- `wing_id` column so the API can return only the nodes belonging to a
-- specific Lifebook's wing.
--
-- Population strategy: best-effort at write time. The
-- provenanceRepository.writeNode() call site that has lifebook context
-- (install/action/feedback events that carry a registryId in the payload)
-- looks up the lifebook for that registryId and stamps its wing_id on the
-- node. Older rows and rows for node types without an obvious lifebook
-- linkage (tier_promotion, external_agent, etc.) stay NULL. A future
-- backfill utility can fill those in if needed.
--
-- Schema-wise: nullable column, no default, no FK constraint to lifebooks
-- (which would block lifebook hard-deletes). The frontend filter only
-- shows nodes with a matching wing_id, so NULL rows are naturally
-- excluded from the per-wing view.

ALTER TABLE capability_provenance_nodes
  ADD COLUMN IF NOT EXISTS wing_id UUID;

-- Partial index keyed on wing-scoped queries. CockroachDB supports
-- partial indexes via the WHERE clause; this keeps the index small
-- (only populated rows) while still serving the per-wing-graph hot path.
CREATE INDEX IF NOT EXISTS capability_provenance_nodes_wing_idx
  ON capability_provenance_nodes (user_id, wing_id, occurred_at DESC)
  WHERE wing_id IS NOT NULL;
