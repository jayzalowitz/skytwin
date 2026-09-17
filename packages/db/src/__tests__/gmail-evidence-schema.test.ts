import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('Gmail evidence schema', () => {
  const migration = read('../migrations/088-gmail-evidence-foundation.sql');
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
    expect(migration).toContain('FOREIGN KEY (resource_ref_id, user_id, connector_account_id)');
    expect(migration).toContain(
      'REFERENCES gmail_message_refs (id, user_id, connector_account_id) ON DELETE CASCADE',
    );
    expect(migration).toContain('connected_accounts_verified_subject_chk');
    expect(migration).toContain("provider_subject_digest ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain('last_observed_inbox BOOL NOT NULL');
    expect(migration).toContain('gmail_message_refs_thread_id_chk');
    expect(migration).toContain('signals_source_signal_id_chk');
    for (const exactShapeCheck of [
      'migration_088_connected_account_identity_preflight',
      'migration_088_oauth_account_binding_preflight',
      'migration_088_cursor_account_binding_preflight',
      'migration_088_gmail_resource_binding_preflight',
      'migration_088_signal_resource_binding_preflight',
    ]) {
      expect(migration).toContain(exactShapeCheck);
    }
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

  it('limits the connector cursor schema-unlock window to required schema changes', () => {
    const unlocks = [...migration.matchAll(/ALTER TABLE connector_cursors SET \(schema_locked = false\)/g)]
      .map((match) => match.index);
    const relocks = [...migration.matchAll(/ALTER TABLE connector_cursors SET \(schema_locked = true\)/g)]
      .map((match) => match.index);
    const firstAddedColumn = migration.indexOf('ALTER TABLE connector_cursors ADD COLUMN IF NOT EXISTS id');
    const firstBackfill = migration.indexOf('UPDATE connector_cursors AS c');
    const swap = migration.indexOf('DROP CONSTRAINT IF EXISTS connector_cursors_pkey');
    const firstSecondaryIndex = migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS connector_cursors_legacy_key');
    const accountForeignKey = migration.indexOf('ADD CONSTRAINT connector_cursors_account_fk');
    const messageRefs = migration.indexOf('CREATE TABLE IF NOT EXISTS gmail_message_refs');
    expect(unlocks).toHaveLength(2);
    expect(relocks).toHaveLength(2);
    expect(unlocks[0]).toBeLessThan(firstAddedColumn);
    expect(relocks[0]).toBeGreaterThan(firstAddedColumn);
    expect(relocks[0]).toBeLessThan(firstBackfill);
    expect(unlocks[1]).toBeLessThan(swap);
    expect(relocks[1]).toBeGreaterThan(swap);
    expect(relocks[1]).toBeGreaterThan(firstSecondaryIndex);
    expect(relocks[1]).toBeGreaterThan(accountForeignKey);
    expect(relocks[1]).toBeLessThan(messageRefs);
  });

  it('never adds content, tokens, or provider-response storage to message refs', () => {
    const table = migration.split('CREATE TABLE IF NOT EXISTS gmail_message_refs')[1]?.split(');')[0] ?? '';
    expect(table).not.toMatch(/\b(body|snippet|access_token|refresh_token|provider_response)\b/i);
  });

  it('includes connector evidence in the derived owned-table rollback batch', () => {
    const source = read('../migrations/001-initial.ts');
    expect(source).toContain('getSkyTwinOwnedTableManifest().current');
    expect(source).toContain('DROP TABLE ${qualifiedTables}');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS gmail_message_refs');
    expect(read('../migrations/024-connector-cursors.sql')).toContain(
      'CREATE TABLE IF NOT EXISTS connector_cursors',
    );
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS connected_accounts');
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
