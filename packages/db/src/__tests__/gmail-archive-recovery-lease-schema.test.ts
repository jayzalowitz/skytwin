import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../migrations/090-gmail-archive-recovery-leases.sql', import.meta.url),
  'utf8',
);
const backup = readFileSync(new URL('../backup/backup.ts', import.meta.url), 'utf8');
const canonicalSchema = readFileSync(new URL('../schemas/schema.sql', import.meta.url), 'utf8');

describe('Gmail archive recovery lease schema', () => {
  it('uses an owner-bound barrier FK and constrained monotonic fence', () => {
    expect(migration).toContain('FOREIGN KEY (admission_id, user_id)');
    expect(migration).toContain('REFERENCES pre_effect_barriers (id, user_id) ON DELETE CASCADE');
    expect(migration).toContain('generation INT8 NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991)');
    expect(migration).toContain('lease_token UUID NOT NULL');
  });

  it('enumerates exact work stages and one-shot observation states', () => {
    for (const value of [
      'resume_preparation', 'resume_claim', 'reconcile_pre_dispatch', 'observe_dispatch',
      'not_started', 'started', 'evidence_recorded',
    ]) expect(migration).toContain(`'${value}'`);
    expect(migration).toContain('gmail_archive_recovery_lease_stage_chk');
    expect(migration).toContain('gmail_archive_recovery_lease_observation_chk');
  });

  it('stores no credentials, provider-native target, message content, or response body', () => {
    const table = migration.split('CREATE TABLE IF NOT EXISTS gmail_archive_recovery_leases')[1] ?? '';
    expect(table).not.toMatch(/access_token|refresh_token|credential_revision|provider_message_id|body|snippet/i);
  });

  it('remains outside portable backup collection and restore', () => {
    expect(backup).toContain('Gmail archive recovery leases are intentionally');
    expect(backup).not.toMatch(/(?:SELECT|INSERT INTO|UPDATE|DELETE FROM) gmail_archive_recovery_leases/i);
  });

  it('is upgrade-only operational state rather than part of the fresh-install base schema', () => {
    expect(canonicalSchema).not.toContain('gmail_archive_recovery_leases');
  });
});
