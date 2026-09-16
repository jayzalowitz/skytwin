-- Make the durable `signals` table the Watch source of truth for every
-- connector account, not only Gmail message evidence.

CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_id_owner_idx
  ON connected_accounts (id, user_id);

ALTER TABLE signals
  ADD CONSTRAINT IF NOT EXISTS signals_connector_account_owner_fk
  FOREIGN KEY (connector_account_id, user_id)
  REFERENCES connected_accounts (id, user_id) ON DELETE CASCADE;
