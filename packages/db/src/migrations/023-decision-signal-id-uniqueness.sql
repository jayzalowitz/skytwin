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

-- Partial unique index — NULL signal_ids stay free. Matches the
-- (user_id, signal_id) tuple the repository checks before inserting.
CREATE UNIQUE INDEX IF NOT EXISTS decisions_user_signal_unique_idx
    ON decisions (user_id, signal_id)
 WHERE signal_id IS NOT NULL;
