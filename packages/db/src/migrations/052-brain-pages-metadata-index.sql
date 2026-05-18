-- 052-brain-pages-metadata-index.sql
-- Inverted index on brain_pages.metadata for the #300 authoringTier filter.
--
-- Background. #300 pushed the authoring-tier predicate into SQL:
--   WHERE metadata->>'authoringTier' = ANY($N)
-- Without an index on metadata, that predicate degrades to a scan of every
-- brain_pages row in the user's partition before the candidate-pool LIMIT
-- can be applied. On users with corpora in the tens of thousands of pages
-- the scan dominates RRF latency.
--
-- CockroachDB inverted indexes on JSONB support the `->>` text accessor for
-- equality / ANY predicates (CRDB v22+), so a single inverted index on
-- `metadata` covers both the authoringTier filter and any future metadata
-- predicates (e.g. fromAddress for the bulk-hide query) without another
-- migration.
--
-- IF NOT EXISTS — safe to re-run. SQLSTATE 42P07 / 42710 surface as
-- idempotent-DDL codes that the migration runner swallows on rerun.

CREATE INVERTED INDEX IF NOT EXISTS brain_pages_metadata_idx
  ON brain_pages (metadata);
