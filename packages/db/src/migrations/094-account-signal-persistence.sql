-- Make the durable `signals` table the Watch source of truth for every
-- connector account, not only Gmail message evidence.

CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_id_owner_idx
  ON connected_accounts (id, user_id);

ALTER TABLE signals
  ADD CONSTRAINT IF NOT EXISTS signals_connector_account_owner_fk
  FOREIGN KEY (connector_account_id, user_id)
  REFERENCES connected_accounts (id, user_id) ON DELETE CASCADE;

-- Session/manual/idle signals have no connector account but still need a
-- durable idempotency key so a retry cannot rewrite Watch evidence.
CREATE UNIQUE INDEX IF NOT EXISTS signals_unbound_source_key
  ON signals (user_id, source, source_signal_id)
  WHERE source_signal_id IS NOT NULL AND connector_account_id IS NULL;
