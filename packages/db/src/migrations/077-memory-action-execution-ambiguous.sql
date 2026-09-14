-- A lost execution response is neither success nor failure. Preserve it as a
-- terminal, non-retryable memory-loop state so the same external effect is not
-- dispatched again merely because reconciliation is still outstanding.
ALTER TABLE memory_action_opportunities DROP CONSTRAINT IF EXISTS check_status;
ALTER TABLE memory_action_opportunities ADD CONSTRAINT check_status CHECK (status IN (
  'suggested',
  'queued_approval',
  'auto_executed',
  'blocked_by_policy',
  'learning_needed',
  'execution_failed',
  'execution_ambiguous',
  'noted_awareness',
  'skipped'
));
