-- 068-memory-action-opportunity-noted-awareness.sql
-- Add the 'noted_awareness' terminal status to memory_action_opportunities (#601).
--
-- The awareness disposition gate now applies to the memory action loop: a
-- passive, reversible, verified-free note from untrusted content (a newsletter)
-- that the injection guard did not escalate is recorded as FYI under the terminal
-- 'noted_awareness' status — no approval row, no execution. Migration 067 created
-- the table with a `check_status` CHECK constraint that predates that status, so
-- without this ALTER every disposition would fail the constraint at write time
-- (after the decision outcome was already persisted, leaving the opportunity
-- non-terminal and re-claimable). Drop-and-recreate; idempotent on re-run because
-- the DROP is `IF EXISTS`. All existing rows hold a subset of the new value set,
-- so re-validation on ADD passes.
ALTER TABLE memory_action_opportunities DROP CONSTRAINT IF EXISTS check_status;
ALTER TABLE memory_action_opportunities ADD CONSTRAINT check_status CHECK (status IN (
  'suggested',
  'queued_approval',
  'auto_executed',
  'blocked_by_policy',
  'learning_needed',
  'execution_failed',
  'noted_awareness',
  'skipped'
));
