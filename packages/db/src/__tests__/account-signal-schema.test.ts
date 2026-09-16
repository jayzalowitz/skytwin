import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  fileURLToPath(new URL('../migrations/094-account-signal-persistence.sql', import.meta.url)),
  'utf8',
);

describe('account signal persistence schema', () => {
  it('binds account signals to their owner with cascading revocation cleanup', () => {
    expect(migration).toContain('connected_accounts_id_owner_idx');
    expect(migration).toContain('FOREIGN KEY (connector_account_id, user_id)');
    expect(migration).toContain('REFERENCES connected_accounts (id, user_id) ON DELETE CASCADE');
  });

  it('gives unbound signals their own partial idempotency key', () => {
    expect(migration).toContain('signals_unbound_source_key');
    expect(migration).toContain('(user_id, source, source_signal_id)');
    expect(migration).toContain('connector_account_id IS NULL');
  });
});
