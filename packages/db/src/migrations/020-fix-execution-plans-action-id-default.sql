-- 020-fix-execution-plans-action-id-default.sql
-- Fix the action_id default from gen_random_uuid() to NULL.
-- The random UUID default violates the FK to candidate_actions.
ALTER TABLE execution_plans ALTER COLUMN action_id SET DEFAULT NULL;
