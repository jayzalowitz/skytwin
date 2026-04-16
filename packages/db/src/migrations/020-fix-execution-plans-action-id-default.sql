-- 020-fix-execution-plans-action-id-default.sql
-- Fix the action_id default from gen_random_uuid() to NULL and make it nullable.
-- The random UUID default violates the FK to candidate_actions, and code now
-- inserts NULL for action_id when execution plans are created from approval
-- responses and streamed events (not tied to a persisted candidate_action row).
ALTER TABLE execution_plans ALTER COLUMN action_id SET DEFAULT NULL;
ALTER TABLE execution_plans ALTER COLUMN action_id DROP NOT NULL;
