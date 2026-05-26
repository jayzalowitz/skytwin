-- 061-cascade-cleanup.sql
-- Backfill ON DELETE CASCADE on every legacy FK that points at users(id) (#413).
--
-- Before this migration, 32 of the 39 user-owned tables had a FK to
-- users(id) without a CASCADE clause. That meant any "delete my account"
-- code path either had to manually enumerate every table (fragile, easy
-- to miss a new one) or got blocked by FK violations on the first row in
-- behavioral_patterns / signals / mempalace / sessions. The fix has to be
-- a one-time DDL backfill — there's no application-layer workaround that
-- actually removes the user's footprint.
--
-- The 7 tables that already had ON DELETE CASCADE
-- (ai_provider_settings, lifebooks, recovery_codes, model_downloads,
-- and a handful of newer ones — connector_health from #377 being the
-- most recent) are skipped here; their FK already cascades and re-running
-- this migration would be a duplicate.
--
-- Naming: CockroachDB auto-generates FK constraint names in the form
-- `<table>_<column>_fkey` when the constraint is declared inline in the
-- column definition (which is how all of these were created — see
-- `schema.sql` and migrations 002/003/004/005/006/008/009/011/012). No FK
-- in this codebase is explicitly named, so the convention is uniform.
--
-- Pattern per table:
--   ALTER TABLE <t> DROP CONSTRAINT IF EXISTS <t>_user_id_fkey;
--   ALTER TABLE <t> ADD  CONSTRAINT <t>_user_id_fkey
--     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
--
-- Idempotent: the DROP uses IF EXISTS so a re-run after the new constraint
-- is in place is a no-op on the DROP step, and the ADD trips
-- duplicate_object (SQLSTATE 42710) which the migration runner swallows
-- via IDEMPOTENT_DDL_CODES.
--
-- Safety net: the `cascade-cleanup.e2e.test.ts` E2E test (gated on E2E=true)
-- queries information_schema after migrations run and fails if any FK to
-- users(id) is still set to NO ACTION. If the conventional name ever fails
-- to match a particular table (e.g. on a fork that hand-named a FK), that
-- E2E test will surface the gap.

-- schema.sql tables (1-7)
ALTER TABLE connected_accounts DROP CONSTRAINT IF EXISTS connected_accounts_user_id_fkey;
ALTER TABLE connected_accounts ADD  CONSTRAINT connected_accounts_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE twin_profiles DROP CONSTRAINT IF EXISTS twin_profiles_user_id_fkey;
ALTER TABLE twin_profiles ADD  CONSTRAINT twin_profiles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE preferences DROP CONSTRAINT IF EXISTS preferences_user_id_fkey;
ALTER TABLE preferences ADD  CONSTRAINT preferences_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_user_id_fkey;
ALTER TABLE decisions ADD  CONSTRAINT decisions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE action_policies DROP CONSTRAINT IF EXISTS action_policies_user_id_fkey;
ALTER TABLE action_policies ADD  CONSTRAINT action_policies_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_user_id_fkey;
ALTER TABLE approval_requests ADD  CONSTRAINT approval_requests_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE feedback_events DROP CONSTRAINT IF EXISTS feedback_events_user_id_fkey;
ALTER TABLE feedback_events ADD  CONSTRAINT feedback_events_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- migrations 002-oauth-tokens.sql (8-9)
ALTER TABLE oauth_tokens DROP CONSTRAINT IF EXISTS oauth_tokens_user_id_fkey;
ALTER TABLE oauth_tokens ADD  CONSTRAINT oauth_tokens_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE connector_configs DROP CONSTRAINT IF EXISTS connector_configs_user_id_fkey;
ALTER TABLE connector_configs ADD  CONSTRAINT connector_configs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- migrations 003-behavioral-patterns.sql (10-11)
ALTER TABLE behavioral_patterns DROP CONSTRAINT IF EXISTS behavioral_patterns_user_id_fkey;
ALTER TABLE behavioral_patterns ADD  CONSTRAINT behavioral_patterns_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE cross_domain_traits DROP CONSTRAINT IF EXISTS cross_domain_traits_user_id_fkey;
ALTER TABLE cross_domain_traits ADD  CONSTRAINT cross_domain_traits_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- migrations 004-eval-history.sql (12-13)
ALTER TABLE eval_runs DROP CONSTRAINT IF EXISTS eval_runs_user_id_fkey;
ALTER TABLE eval_runs ADD  CONSTRAINT eval_runs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE accuracy_metrics DROP CONSTRAINT IF EXISTS accuracy_metrics_user_id_fkey;
ALTER TABLE accuracy_metrics ADD  CONSTRAINT accuracy_metrics_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- migrations 005-scope-expansion.sql (14-19)
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_user_id_fkey;
ALTER TABLE signals ADD  CONSTRAINT signals_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE preference_proposals DROP CONSTRAINT IF EXISTS preference_proposals_user_id_fkey;
ALTER TABLE preference_proposals ADD  CONSTRAINT preference_proposals_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE twin_exports DROP CONSTRAINT IF EXISTS twin_exports_user_id_fkey;
ALTER TABLE twin_exports ADD  CONSTRAINT twin_exports_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE skill_gap_log DROP CONSTRAINT IF EXISTS skill_gap_log_user_id_fkey;
ALTER TABLE skill_gap_log ADD  CONSTRAINT skill_gap_log_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE proactive_scans DROP CONSTRAINT IF EXISTS proactive_scans_user_id_fkey;
ALTER TABLE proactive_scans ADD  CONSTRAINT proactive_scans_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE briefings DROP CONSTRAINT IF EXISTS briefings_user_id_fkey;
ALTER TABLE briefings ADD  CONSTRAINT briefings_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- migrations 006-trust-tier-audit.sql (20)
ALTER TABLE trust_tier_audit DROP CONSTRAINT IF EXISTS trust_tier_audit_user_id_fkey;
ALTER TABLE trust_tier_audit ADD  CONSTRAINT trust_tier_audit_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- migrations 008-spend-tracking.sql (21)
ALTER TABLE spend_records DROP CONSTRAINT IF EXISTS spend_records_user_id_fkey;
ALTER TABLE spend_records ADD  CONSTRAINT spend_records_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- migrations 009-domain-autonomy-escalation.sql (22-23)
ALTER TABLE domain_autonomy_policies DROP CONSTRAINT IF EXISTS domain_autonomy_policies_user_id_fkey;
ALTER TABLE domain_autonomy_policies ADD  CONSTRAINT domain_autonomy_policies_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE escalation_triggers DROP CONSTRAINT IF EXISTS escalation_triggers_user_id_fkey;
ALTER TABLE escalation_triggers ADD  CONSTRAINT escalation_triggers_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- migrations 011-sessions.sql (24)
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_id_fkey;
ALTER TABLE sessions ADD  CONSTRAINT sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- migrations 012-mempalace.sql (25-32)
ALTER TABLE memory_wings DROP CONSTRAINT IF EXISTS memory_wings_user_id_fkey;
ALTER TABLE memory_wings ADD  CONSTRAINT memory_wings_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE memory_drawers DROP CONSTRAINT IF EXISTS memory_drawers_user_id_fkey;
ALTER TABLE memory_drawers ADD  CONSTRAINT memory_drawers_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE memory_closets DROP CONSTRAINT IF EXISTS memory_closets_user_id_fkey;
ALTER TABLE memory_closets ADD  CONSTRAINT memory_closets_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE memory_tunnels DROP CONSTRAINT IF EXISTS memory_tunnels_user_id_fkey;
ALTER TABLE memory_tunnels ADD  CONSTRAINT memory_tunnels_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE knowledge_entities DROP CONSTRAINT IF EXISTS knowledge_entities_user_id_fkey;
ALTER TABLE knowledge_entities ADD  CONSTRAINT knowledge_entities_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE knowledge_triples DROP CONSTRAINT IF EXISTS knowledge_triples_user_id_fkey;
ALTER TABLE knowledge_triples ADD  CONSTRAINT knowledge_triples_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE episodic_memories DROP CONSTRAINT IF EXISTS episodic_memories_user_id_fkey;
ALTER TABLE episodic_memories ADD  CONSTRAINT episodic_memories_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE entity_codes DROP CONSTRAINT IF EXISTS entity_codes_user_id_fkey;
ALTER TABLE entity_codes ADD  CONSTRAINT entity_codes_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
