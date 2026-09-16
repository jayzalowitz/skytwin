import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  fileURLToPath(new URL('../migrations/094-account-signal-persistence.sql', import.meta.url)),
  'utf8',
);

describe('account signal persistence schema', () => {
  it('binds account signals to their owner with cascading revocation cleanup', () => {
    expect(migration).toContain('connected_accounts_id_user_key');
    expect(migration).toContain('FOREIGN KEY (connector_account_id, user_id)');
    expect(migration).toContain('REFERENCES connected_accounts (id, user_id) ON DELETE CASCADE');
    expect(migration).toContain('migration_094_account_owner_index_preflight');
    expect(migration).toContain('migration_094_signal_account_owner_fk_preflight');
    expect(migration).not.toContain('CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_id_owner_idx');
  });
});
