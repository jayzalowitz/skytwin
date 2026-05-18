-- 054-spend-records-registry-id.sql
-- Add `registry_id` to `spend_records` so per-app monthly totals can be
-- computed (#323, decomposed from #306). Closes the
-- `getMonthlyTotal(userId, appRegistryId)` stub that returned 0 as a
-- safe fallback because no column existed to join on.
--
-- Nullable on purpose. Existing rows stay NULL — they predate the
-- decision pipeline's ability to attribute spend to a registry source.
-- `getMonthlyTotal(userId)` (no appRegistryId) continues to sum
-- everything regardless of `registry_id`; only the
-- `getMonthlyTotal(userId, appRegistryId)` form filters on the column.
-- Future MCP-action spend recording (tracked separately) populates
-- the field on new writes.
--
-- Composite index covers the per-app monthly query:
--   WHERE user_id = $1 AND registry_id = $2 AND recorded_at >= date_trunc('month', now())
-- CockroachDB plans this as an index lookup. Without the index the
-- query falls back to scanning the existing `idx_spend_user_time` rows
-- and filtering in-memory, which is fine at today's volume but pays
-- off the first time someone writes a few thousand MCP-action records
-- per user per month.
--
-- IF NOT EXISTS — safe to re-run.
ALTER TABLE spend_records ADD COLUMN IF NOT EXISTS registry_id STRING;

CREATE INDEX IF NOT EXISTS idx_spend_user_registry_time
  ON spend_records (user_id, registry_id, recorded_at DESC);
