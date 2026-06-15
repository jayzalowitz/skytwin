/**
 * backup-restore-guards.test.ts — validation + pre-DB guards in restoreBackup
 * and validateBackupData (#400).
 *
 * The connection + repository modules are mocked so these tests run without a
 * real DB. They cover the paths that should reject BEFORE any write happens:
 * malformed payloads, unsupported schema versions, and an already-existing
 * user. The happy-path DB write itself is covered end-to-end against a real
 * CRDB in the e2e suite; here we assert the guards fail closed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let userExists = false;

vi.mock('../connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
  ),
}));

vi.mock('../repositories/user-repository.js', () => ({
  userRepository: {
    findById: vi.fn(async () => (userExists ? { id: 'u1' } : null)),
  },
}));

vi.mock('../repositories/twin-repository.js', () => ({
  twinRepository: { getProfile: vi.fn(async () => null) },
}));

import { restoreBackup, validateBackupData, BACKUP_SCHEMA_VERSION } from '../backup/backup.js';

beforeEach(() => {
  userExists = false;
});

function validPayload(): Record<string, unknown> {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: '2026-06-15T00:00:00.000Z',
    user: {
      id: 'u1',
      email: 'a@b.c',
      name: 'A',
      trust_tier: 'observer',
      autonomy_settings: {},
      ironclaw_channel: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
    twinProfile: null,
    twinProfileVersions: [],
    preferences: [],
    decisions: [],
  };
}

describe('validateBackupData', () => {
  it('accepts a well-formed payload', () => {
    expect(validateBackupData(validPayload())).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateBackupData('nope')).toContain('payload is not an object');
    expect(validateBackupData(null)).toContain('payload is not an object');
  });

  it('reports each missing required field', () => {
    const problems = validateBackupData({ schemaVersion: 1 });
    expect(problems).toContain('missing user');
    expect(problems).toContain('preferences is not an array');
    expect(problems).toContain('decisions is not an array');
    expect(problems).toContain('twinProfileVersions is not an array');
  });
});

describe('restoreBackup guards', () => {
  it('rejects an invalid payload before any DB write', async () => {
    const result = await restoreBackup({ not: 'a backup' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('invalid_data');
  });

  it('rejects an unsupported schema version', async () => {
    const payload = { ...validPayload(), schemaVersion: 999 };
    const result = await restoreBackup(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('unsupported_schema');
  });

  it('refuses to clobber an existing user (fresh-install only)', async () => {
    userExists = true;
    const result = await restoreBackup(validPayload());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('user_exists');
  });

  it('restores a fresh install and reports row counts', async () => {
    userExists = false;
    const result = await restoreBackup(validPayload());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.summary.counts.users).toBe(1);
      expect(result.summary.total).toBeGreaterThanOrEqual(1);
    }
  });
});
