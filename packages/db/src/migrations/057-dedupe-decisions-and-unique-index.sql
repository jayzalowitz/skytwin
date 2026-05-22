-- 057-dedupe-decisions-and-unique-index.sql
-- Dedupe (user_id, signal_id) duplicates and add the partial unique
-- index that #102 originally tried to land in migration 023.
--
-- Why this lives at 057 instead of 023: the dedupe needs to walk every
-- table that FKs to decisions(id) (candidate_actions, decision_outcomes,
-- approval_requests, execution_plans → execution_results +
-- execution_events, explanation_records, feedback_events,
-- trust_tier_audit, knowledge_triples) AND clear the nullable
-- decision_outcomes.execution_plan_id added in migration 055 before
-- deleting execution_plans rows. At migration 023's apply time, the 055
-- column doesn't exist yet — earlier in-23 dedupes failed with "column
-- decision_id does not exist" (referring to a future migration's
-- column). Running the full dedupe + index here, AFTER the schema is
-- complete, keeps each step well-typed against the live schema.
--
-- Idempotency: every DELETE/UPDATE is scoped to "decisions where
-- signal_id is non-null AND there's a newer dup" — once we've run, the
-- dup set is empty and re-running is a no-op. The CREATE INDEX uses
-- IF NOT EXISTS for the same reason; installs that already have the
-- index (because migration 023 ran successfully on a clean DB before
-- this split) get a free no-op.

WITH dup_decisions AS (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY user_id, signal_id
             ORDER BY created_at ASC, id ASC
           ) AS rn
      FROM decisions
     WHERE signal_id IS NOT NULL
  ) ranked
  WHERE rn > 1
)
DELETE FROM execution_events
 WHERE plan_id IN (
   SELECT id FROM execution_plans WHERE decision_id IN (SELECT id FROM dup_decisions)
 );

WITH dup_decisions AS (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, signal_id ORDER BY created_at ASC, id ASC) AS rn
      FROM decisions WHERE signal_id IS NOT NULL
  ) r WHERE rn > 1
)
DELETE FROM execution_results
 WHERE plan_id IN (
   SELECT id FROM execution_plans WHERE decision_id IN (SELECT id FROM dup_decisions)
 );

-- decision_outcomes.execution_plan_id was added by migration 055 — it
-- exists by 057's apply time. Null the link before we delete the
-- execution_plans rows that the dup decisions own.
WITH dup_decisions AS (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, signal_id ORDER BY created_at ASC, id ASC) AS rn
      FROM decisions WHERE signal_id IS NOT NULL
  ) r WHERE rn > 1
)
UPDATE decision_outcomes SET execution_plan_id = NULL
 WHERE execution_plan_id IN (
   SELECT id FROM execution_plans WHERE decision_id IN (SELECT id FROM dup_decisions)
 );

WITH dup_decisions AS (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, signal_id ORDER BY created_at ASC, id ASC) AS rn
      FROM decisions WHERE signal_id IS NOT NULL
  ) r WHERE rn > 1
)
DELETE FROM execution_plans WHERE decision_id IN (SELECT id FROM dup_decisions);

WITH dup_decisions AS (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, signal_id ORDER BY created_at ASC, id ASC) AS rn
      FROM decisions WHERE signal_id IS NOT NULL
  ) r WHERE rn > 1
)
DELETE FROM feedback_events WHERE decision_id IN (SELECT id FROM dup_decisions);

WITH dup_decisions AS (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, signal_id ORDER BY created_at ASC, id ASC) AS rn
      FROM decisions WHERE signal_id IS NOT NULL
  ) r WHERE rn > 1
)
DELETE FROM explanation_records WHERE decision_id IN (SELECT id FROM dup_decisions);

WITH dup_decisions AS (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, signal_id ORDER BY created_at ASC, id ASC) AS rn
      FROM decisions WHERE signal_id IS NOT NULL
  ) r WHERE rn > 1
)
DELETE FROM approval_requests WHERE decision_id IN (SELECT id FROM dup_decisions);

WITH dup_decisions AS (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, signal_id ORDER BY created_at ASC, id ASC) AS rn
      FROM decisions WHERE signal_id IS NOT NULL
  ) r WHERE rn > 1
)
DELETE FROM decision_outcomes WHERE decision_id IN (SELECT id FROM dup_decisions);

WITH dup_decisions AS (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, signal_id ORDER BY created_at ASC, id ASC) AS rn
      FROM decisions WHERE signal_id IS NOT NULL
  ) r WHERE rn > 1
)
DELETE FROM candidate_actions WHERE decision_id IN (SELECT id FROM dup_decisions);

-- Finally, the duplicate decisions themselves.
DELETE FROM decisions
 WHERE id IN (
   SELECT id FROM (
     SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY user_id, signal_id
              ORDER BY created_at ASC, id ASC
            ) AS rn
       FROM decisions
      WHERE signal_id IS NOT NULL
   ) ranked
   WHERE rn > 1
 );

-- Partial unique index — NULL signal_ids stay free. Matches the
-- (user_id, signal_id) tuple the repository checks before inserting.
CREATE UNIQUE INDEX IF NOT EXISTS decisions_user_signal_unique_idx
    ON decisions (user_id, signal_id)
 WHERE signal_id IS NOT NULL;
