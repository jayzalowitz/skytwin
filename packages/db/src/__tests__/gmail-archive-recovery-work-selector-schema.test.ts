import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../migrations/091-gmail-archive-recovery-work-selector.sql', import.meta.url),
  'utf8',
);
const canonicalSchema = readFileSync(new URL('../schemas/schema.sql', import.meta.url), 'utf8');

describe('Gmail archive recovery work selector migration', () => {
  it('adds the bounded scan index with the exact nonterminal partial predicate', () => {
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS pre_effect_barriers_gmail_archive_recovery_scan_idx',
    );
    expect(migration).toContain('ON pre_effect_barriers (updated_at, idempotency_key)');
    expect(migration).toContain('STORING (user_id, status, created_at)');
    expect(migration).toContain("effect_type = 'event_execution'");
    expect(migration).toContain("status IN ('reserved', 'prepared', 'in_progress')");
  });

  it('adds no table, authority column, credential, or portable schema state', () => {
    expect(migration).not.toMatch(/CREATE TABLE|ALTER TABLE/i);
    expect(migration).not.toMatch(/access_token|refresh_token|provider_message_id|lease_token|generation|evidence/i);
    expect(canonicalSchema).not.toContain('pre_effect_barriers_gmail_archive_recovery_scan_idx');
  });
});
