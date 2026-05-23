-- 055-decision-outcomes-execution-plan-id.sql
-- Decision↔execution structural linkage (#324, decomposed from #306).
--
-- Background. `decision_outcomes` is already 1:1 with `decisions`
-- (UNIQUE on decision_id). `execution_plans` is effectively 1:1 with
-- decisions in practice — `executionRepository.getByDecisionId` uses
-- `ORDER BY created_at DESC LIMIT 1` to handle the rare retry case
-- where a second plan exists for the same decision (e.g.
-- `apps/api/src/routes/approvals.ts` inserting a fresh plan after a
-- rejection). Both tables reach `decisions` independently — there
-- has been no FK between them. The 4 stubbed sites in
-- `apps/api/src/routes/capabilities.ts` (#306) and the duplicate stub
-- in `apps/worker/src/jobs/promotion-eligibility-check.ts` were
-- proxying via `capability_provenance_nodes` because the structural
-- linkage didn't exist.
--
-- Direction. `decision_outcomes.execution_plan_id UUID NULL REFERENCES
-- execution_plans(id)`. Putting the FK on `decision_outcomes` (rather
-- than another column on `execution_plans → decision_outcomes`) is
-- the right call because:
--   1. `decision_outcomes` is uniquely keyed on `decision_id`, so the
--      column lives where the cardinality enforces it (1:1).
--   2. The approval path creates `decision_outcomes` BEFORE
--      `execution_plans` (the outcome exists while the action is
--      still pending approval). NULL gracefully covers that interval;
--      flipping the FK would require a placeholder plan or a much
--      uglier nullable column on `execution_plans → outcome`.
--   3. The existing `execution_plans.decision_id` FK already gives a
--      reverse lookup; adding `decision_outcomes.execution_plan_id`
--      is the missing forward edge, not a redundant one.
--
-- Nullable on purpose. Approval-pending outcomes have no execution
-- plan yet; auto-execute outcomes get a plan immediately and the
-- write path populates the column then. NULL is the correct sentinel.
-- NOT NULL would require a backfill that invents plans for
-- approval-pending rows, which is wrong.
--
-- Index on the new FK so the FK validation + reverse lookups
-- (e.g. \"which outcome owns this plan?\") stay cheap.
-- IF NOT EXISTS — safe to re-run.
ALTER TABLE decision_outcomes
  ADD COLUMN IF NOT EXISTS execution_plan_id UUID REFERENCES execution_plans(id);

CREATE INDEX IF NOT EXISTS idx_decision_outcomes_execution_plan
  ON decision_outcomes (execution_plan_id)
  WHERE execution_plan_id IS NOT NULL;

-- Backfill. Source from `execution_plans` joined to `decision_outcomes`
-- on `decision_id`. For decisions that have multiple plans (retries),
-- pick the most recent plan — matches the
-- `executionRepository.getByDecisionId` ORDER BY behavior already
-- used by every read site that has had to disambiguate.
--
-- IDEMPOTENT: only updates rows where the column is still NULL, so
-- re-runs after partial application are no-ops. Rows where the
-- decision never produced a plan (approval-pending today, rejected
-- decisions) stay NULL — that's correct.
--
-- DISTINCT ON (outcomes.id) ensures one source plan per outcome even
-- when the join produces multiple plan rows.
--
-- The alias is `outcomes` (not `do`) because `do` is a reserved keyword
-- in CockroachDB v23.2+ and rejects with a 42601 lexer error. Fresh
-- installs on any recent CRDB failed at this migration until the
-- rename. Re-running against an already-migrated DB is a no-op because
-- of the IF NOT EXISTS on the column and the WHERE execution_plan_id
-- IS NULL guard on the backfill.
UPDATE decision_outcomes outcomes
SET execution_plan_id = src.plan_id
FROM (
  SELECT DISTINCT ON (do_inner.id)
    do_inner.id   AS outcome_id,
    ep.id         AS plan_id
  FROM decision_outcomes do_inner
  JOIN execution_plans ep ON ep.decision_id = do_inner.decision_id
  WHERE do_inner.execution_plan_id IS NULL
  ORDER BY do_inner.id, ep.created_at DESC
) src
WHERE outcomes.id = src.outcome_id
  AND outcomes.execution_plan_id IS NULL;
