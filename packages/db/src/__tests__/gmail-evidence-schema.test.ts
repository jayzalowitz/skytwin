import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('Gmail evidence schema', () => {
  const migration = read('../migrations/082-gmail-evidence-foundation.sql');
  const schema = read('../schemas/schema.sql');

  it('keeps upgrade-only DDL out of the bootstrap schema that runs before migrations', () => {
    for (const fragment of [
      'provider_subject_digest STRING',
      'identity_verified BOOL NOT NULL DEFAULT false',
      'credential_revision UUID NOT NULL DEFAULT gen_random_uuid()',
      'CREATE TABLE IF NOT EXISTS gmail_message_refs',
      'gmail_message_refs_authoring_tier_chk',
      'gmail_message_refs_observation_order_chk',
      'UNIQUE (connector_account_id, provider_message_id)',
      'UNIQUE (connector_account_id, source_signal_id)',
    ]) {
      expect(migration).toContain(fragment);
      expect(schema).not.toContain(fragment);
    }
  });

  it('enforces owner-preserving cascades and account-qualified signal idempotency', () => {
    expect(migration).toContain('FOREIGN KEY (connector_account_id, user_id, provider)');
    expect(migration).toContain('REFERENCES connected_accounts (id, user_id, provider) ON DELETE CASCADE');
    expect(migration).toContain('signals_owned_source_key');
    expect(migration).toContain('(user_id, source, connector_account_id, source_signal_id)');
    expect(migration).toContain('signals_gmail_resource_owner_fk');
    expect(migration).toContain('connected_accounts_verified_subject_chk');
    expect(migration).toContain("provider_subject_digest ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain('last_observed_inbox BOOL NOT NULL');
    expect(migration).toContain('gmail_message_refs_thread_id_chk');
    expect(migration).toContain('signals_source_signal_id_chk');
  });

  it('makes the deliberate legacy reconnect pause observable', () => {
    expect(migration).toContain("'identity_verification_required'");
    expect(migration).toContain("WHEN 'google' THEN 'gmail:'");
    expect(migration).toContain("WHEN 'microsoft' THEN 'outlook_mail:'");
  });

  it('maps each legacy cursor name to its OAuth provider before account binding', () => {
    expect(migration).toContain("WHEN 'google_calendar' THEN 'google'");
    expect(migration).toContain("WHEN 'outlook' THEN 'microsoft'");
    expect(migration).toContain("WHEN 'outlook_calendar' THEN 'microsoft'");
  });

  it('never adds content, tokens, or provider-response storage to message refs', () => {
    const table = migration.split('CREATE TABLE IF NOT EXISTS gmail_message_refs')[1]?.split(');')[0] ?? '';
    expect(table).not.toMatch(/\b(body|snippet|access_token|refresh_token|provider_response)\b/i);
  });

  it('drops evidence and cursor children before connected_accounts on down', () => {
    const source = read('../migrations/001-initial.ts');
    const refs = source.indexOf("'gmail_message_refs'");
    const cursors = source.indexOf("'connector_cursors'");
    const accounts = source.indexOf("'connected_accounts'");
    expect(refs).toBeGreaterThan(-1);
    expect(cursors).toBeGreaterThan(-1);
    expect(refs).toBeLessThan(accounts);
    expect(cursors).toBeLessThan(accounts);
  });

  it('makes connector evidence an explicit purge concern and excludes it from portable backup', () => {
    const purge = read('../repositories/user-purge-repository.ts');
    const backup = read('../backup/backup.ts');
    expect(purge).toContain("table: 'signals'");
    expect(purge).toContain("table: 'connector_cursors'");
    expect(purge).toContain("table: 'gmail_message_refs'");
    expect(purge).toContain("table: 'oauth_tokens'");
    expect(purge).toContain("table: 'connected_accounts'");
    expect(backup).toContain('Connector identities, OAuth credentials, cursors, raw signals, and Gmail');
  });
});
