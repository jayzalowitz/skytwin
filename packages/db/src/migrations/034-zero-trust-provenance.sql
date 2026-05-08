-- 034-zero-trust-provenance.sql
-- Extend the capability_provenance_nodes.node_type CHECK constraint to include
-- 'zero_trust_change', used when a user toggles zero-trust mode on an MCP server.
-- Issue #183 AC#4 (partial — policy + UI; container runtime deferred to #180).
--
-- CockroachDB: drop the old constraint by name and add the expanded one.
-- PostgreSQL: same ALTER TABLE … DROP CONSTRAINT / ADD CONSTRAINT pattern.
--
-- The constraint name in 027-capability-acquisition.sql is
-- "capability_provenance_nodes_node_type_check" (CockroachDB auto-naming).
-- We rename to 'cpn_node_type_check' for clarity going forward.

ALTER TABLE capability_provenance_nodes
  DROP CONSTRAINT IF EXISTS capability_provenance_nodes_node_type_check;

ALTER TABLE capability_provenance_nodes
  ADD CONSTRAINT cpn_node_type_check CHECK (node_type IN (
    'signal', 'entity', 'suggestion', 'install', 'tier_promotion',
    'action', 'feedback', 'uninstall', 'external_agent', 'zero_trust_change'
  ));
