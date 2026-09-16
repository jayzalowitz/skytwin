-- Make the durable `signals` table the Watch source of truth for every
-- connector account, not only Gmail message evidence. Migration 088 already
-- installs connected_accounts_id_user_key for the same owner tuple; reuse and
-- verify it instead of creating a second identical index on every upgrade.

SELECT 1 / 0 AS migration_094_account_owner_index_preflight
WHERE NOT (
  (SELECT count(*) FROM [SHOW INDEXES FROM connected_accounts]
    WHERE index_name = 'connected_accounts_id_user_key'
      AND non_unique = false AND storing = false AND implicit = false) = 2
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM connected_accounts]
     WHERE index_name = 'connected_accounts_id_user_key' AND seq_in_index = 1
       AND column_name = 'id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM connected_accounts]
     WHERE index_name = 'connected_accounts_id_user_key' AND seq_in_index = 2
       AND column_name = 'user_id' AND direction = 'ASC'
       AND non_unique = false AND storing = false AND implicit = false
  )
  AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index index_metadata
      JOIN pg_catalog.pg_class index_class ON index_class.oid = index_metadata.indexrelid
      JOIN pg_catalog.pg_class table_class ON table_class.oid = index_metadata.indrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE index_class.relname = 'connected_accounts_id_user_key'
       AND table_class.relname = 'connected_accounts'
       AND namespace.nspname = current_schema()
       AND index_metadata.indisunique = true
       AND index_metadata.indnkeyatts = 2
       AND index_metadata.indpred IS NULL
  )
);

ALTER TABLE signals
  ADD CONSTRAINT IF NOT EXISTS signals_connector_account_owner_fk
  FOREIGN KEY (connector_account_id, user_id)
  REFERENCES connected_accounts (id, user_id) ON DELETE CASCADE;

-- IF NOT EXISTS must never turn a malformed namesake into a successful
-- ownership migration.
SELECT 1 / 0 AS migration_094_signal_account_owner_fk_preflight
WHERE NOT EXISTS (
  SELECT 1 FROM [SHOW CONSTRAINTS FROM signals]
   WHERE constraint_name = 'signals_connector_account_owner_fk'
     AND constraint_type = 'FOREIGN KEY'
     AND details =
       'FOREIGN KEY (connector_account_id, user_id) REFERENCES connected_accounts(id, user_id) ON DELETE CASCADE'
     AND validated = true
);
