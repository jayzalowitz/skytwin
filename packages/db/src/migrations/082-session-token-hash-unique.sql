-- A token hash identifies exactly one session for its entire lifetime. Do not
-- repair duplicates: their owner is ambiguous, so an upgrade must stop for an
-- operator to investigate rather than select a row.
SELECT 1 / 0 AS migration_082_duplicate_session_token_hash
 WHERE EXISTS (
   SELECT token_hash FROM sessions GROUP BY token_hash HAVING count(*) > 1
 );

-- The historical partial lookup index remains for compatibility with replayed
-- migration 011. This distinct, global index is the authority constraint.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique_idx
  ON sessions (token_hash);

-- IF NOT EXISTS must not trust a pre-existing namesake with weaker semantics.
SELECT 1 / 0 AS migration_082_index_shape_assertion
 WHERE NOT EXISTS (
   SELECT 1 FROM [SHOW INDEXES FROM sessions]
    WHERE index_name = 'sessions_token_hash_unique_idx'
    GROUP BY index_name
   HAVING bool_and(NOT non_unique)
      AND count(*) FILTER (WHERE NOT storing AND NOT implicit) = 1
      AND count(*) FILTER (
        WHERE seq_in_index = 1 AND column_name = 'token_hash'
          AND NOT storing AND NOT implicit
      ) = 1
 );
