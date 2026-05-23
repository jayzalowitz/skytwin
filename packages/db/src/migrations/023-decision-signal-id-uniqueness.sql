-- 023-decision-signal-id-uniqueness.sql
-- Defense-in-depth: stop duplicate decisions for the same forwarded signal.
--
-- Today the worker has a persistent dedupe ledger (#102), but the API has no
-- backstop — if the deduper ever misses (cold cache before hydrate, race
-- between two workers, manual replay), each duplicate forwarded signal
-- creates a fresh decision row, which creates a fresh approval. The user
-- sees the same gmail thread surface twice in their approval queue.
--
-- This migration extracts the signal id from the existing raw_event JSON
-- into a typed column and adds a partial unique index keyed on
-- (user_id, signal_id) — partial because legacy rows have no signal id and
-- we don't want NULL-collision behaviour. The decision repository pre-checks
-- on this column so duplicate ingests return the existing row instead of
-- erroring with a 23505.

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS signal_id STRING;

-- Backfill from raw_event->>'signalId' (the field the worker writes).
UPDATE decisions
   SET signal_id = raw_event->>'signalId'
 WHERE signal_id IS NULL
   AND raw_event ? 'signalId';

-- Adding the column + backfilling are pure-additive operations that
-- compose with any existing data shape, so they stay in this migration.
-- The duplicate-dedupe and the partial UNIQUE INDEX have moved to
-- migration 057-dedupe-decisions-and-unique-index.sql so they can run
-- AFTER the full schema is in place — earlier attempts here failed
-- because the FK chain we'd need to walk for dedupe references columns
-- (e.g. decision_outcomes.execution_plan_id from migration 055) that
-- don't exist yet at migration 023's apply time.
--
-- Net effect for fresh installs: 023 adds signal_id, 024–056 build the
-- rest of the schema, 057 dedupes any historical dupes and creates the
-- unique index. Net effect for existing installs that already had the
-- index applied (CI, prod): 057's CREATE UNIQUE INDEX IF NOT EXISTS is
-- a no-op.
