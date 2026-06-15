/**
 * backup-cli.test.ts — orchestration tests for `skytwin-backup` (#400).
 *
 * runBackupCli takes all of its IO (file read/write, passphrase source,
 * data layer) as injected callbacks, so these tests exercise the full
 * export/restore flow with NO real DB and NO real filesystem.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';

// backup-cli.ts statically imports ../connection.js (for closePool in its
// main-module block) which pulls in `pg`. runBackupCli itself never touches
// the DB — all IO is injected — so we stub the connection module to keep the
// import graph resolvable without a real `pg`.
vi.mock('../connection.js', () => ({
  closePool: vi.fn(async () => {}),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { runBackupCli, type BackupCliIo } from '../bin/backup-cli.js';
import { encodeArchive, decodeArchive } from '../backup/archive.js';
import type { BackupData } from '../backup/backup.js';

const PASSPHRASE = 'a-strong-passphrase-123';

function makeBackupData(): BackupData {
  return {
    schemaVersion: 1,
    exportedAt: '2026-06-15T00:00:00.000Z',
    user: {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      email: 'me@example.com',
      name: 'Me',
      trust_tier: 'observer',
      autonomy_settings: {},
      ironclaw_channel: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
    },
    twinProfile: null,
    twinProfileVersions: [],
    preferences: [],
    decisions: [],
  };
}

interface Harness {
  io: BackupCliIo;
  files: Map<string, Buffer>;
  logs: string[];
  errors: string[];
  collectBackup: Mock;
  restoreBackup: Mock;
}

function makeHarness(overrides: Partial<BackupCliIo> = {}): Harness {
  const files = new Map<string, Buffer>();
  const logs: string[] = [];
  const errors: string[] = [];

  const collectBackup = vi.fn(async (_userId: string) => ({
    success: true as const,
    data: makeBackupData(),
  }));
  const restoreBackup = vi.fn(async (_value: unknown) => ({
    success: true as const,
    summary: { counts: { users: 1 }, total: 1 },
  }));

  const io: BackupCliIo = {
    readFile: async (path) => {
      const f = files.get(path);
      if (!f) throw new Error(`ENOENT: ${path}`);
      return f;
    },
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    getPassphrase: () => PASSPHRASE,
    collectBackup: collectBackup as unknown as BackupCliIo['collectBackup'],
    restoreBackup: restoreBackup as unknown as BackupCliIo['restoreBackup'],
    encodeArchive,
    decodeArchive,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    ...overrides,
  };

  return { io, files, logs, errors, collectBackup, restoreBackup };
}

describe('runBackupCli — export', () => {
  it('writes an encrypted archive that decodes back to the exported data', async () => {
    const h = makeHarness();
    const result = await runBackupCli(
      ['export', '--user', 'aaaaaaaa-bbbb-cccc-dddd-000000000001', '--out', 'backup.stbk'],
      h.io,
    );

    expect(result.exitCode).toBe(0);
    expect(h.collectBackup).toHaveBeenCalledWith('aaaaaaaa-bbbb-cccc-dddd-000000000001');

    const archive = h.files.get('backup.stbk');
    expect(archive).toBeDefined();
    // The written file is the encrypted archive, not plaintext JSON.
    expect(archive!.subarray(0, 4).toString('ascii')).toBe('STBK');

    const decoded = await decodeArchive(archive!, PASSPHRASE);
    expect(decoded.success).toBe(true);
    if (decoded.success) {
      const parsed = JSON.parse(decoded.json) as BackupData;
      expect(parsed.user.email).toBe('me@example.com');
    }
  });

  it('fails when --user or --out is missing', async () => {
    const h = makeHarness();
    const result = await runBackupCli(['export', '--user', 'x'], h.io);
    expect(result.exitCode).toBe(1);
    expect(h.errors.join('\n')).toMatch(/--out/);
  });

  it('fails when the user does not exist', async () => {
    const h = makeHarness({
      collectBackup: (async () => ({
        success: false,
        reason: 'user_not_found',
        message: 'no user with id ghost',
      })) as unknown as BackupCliIo['collectBackup'],
    });
    const result = await runBackupCli(
      ['export', '--user', 'ghost', '--out', 'b.stbk'],
      h.io,
    );
    expect(result.exitCode).toBe(1);
    expect(h.errors.join('\n')).toMatch(/no user with id ghost/);
  });
});

describe('runBackupCli — restore', () => {
  it('decrypts an archive and restores it', async () => {
    const h = makeHarness();
    const archive = await encodeArchive(JSON.stringify(makeBackupData()), PASSPHRASE);
    h.files.set('in.stbk', archive);

    const result = await runBackupCli(['restore', 'in.stbk'], h.io);
    expect(result.exitCode).toBe(0);
    expect(h.restoreBackup).toHaveBeenCalledOnce();
    expect(h.logs.join('\n')).toMatch(/Restored 1 rows/);
  });

  it('fails on a missing archive file', async () => {
    const h = makeHarness();
    const result = await runBackupCli(['restore', 'nope.stbk'], h.io);
    expect(result.exitCode).toBe(1);
    expect(h.restoreBackup).not.toHaveBeenCalled();
    expect(h.errors.join('\n')).toMatch(/could not read/);
  });

  it('fails with the wrong passphrase and never touches the DB', async () => {
    const h = makeHarness({ getPassphrase: () => 'a-different-passphrase-99' });
    const archive = await encodeArchive(JSON.stringify(makeBackupData()), PASSPHRASE);
    h.files.set('in.stbk', archive);

    const result = await runBackupCli(['restore', 'in.stbk'], h.io);
    expect(result.exitCode).toBe(1);
    expect(h.restoreBackup).not.toHaveBeenCalled();
    expect(h.errors.join('\n')).toMatch(/wrong passphrase or the file is corrupt/);
  });

  it('surfaces a user_exists restore conflict', async () => {
    const h = makeHarness({
      restoreBackup: (async () => ({
        success: false,
        reason: 'user_exists',
        message: 'user already exists; purge first',
      })) as unknown as BackupCliIo['restoreBackup'],
    });
    const archive = await encodeArchive(JSON.stringify(makeBackupData()), PASSPHRASE);
    h.files.set('in.stbk', archive);

    const result = await runBackupCli(['restore', 'in.stbk'], h.io);
    expect(result.exitCode).toBe(1);
    expect(h.errors.join('\n')).toMatch(/purge first/);
  });
});

describe('runBackupCli — passphrase + usage guards', () => {
  it('fails when SKYTWIN_BACKUP_PASSPHRASE is unset', async () => {
    const h = makeHarness({ getPassphrase: () => undefined });
    const result = await runBackupCli(['export', '--user', 'x', '--out', 'y'], h.io);
    expect(result.exitCode).toBe(1);
    expect(h.errors.join('\n')).toMatch(/SKYTWIN_BACKUP_PASSPHRASE is not set/);
  });

  it('fails when the passphrase is too short', async () => {
    const h = makeHarness({ getPassphrase: () => 'short' });
    const result = await runBackupCli(['export', '--user', 'x', '--out', 'y'], h.io);
    expect(result.exitCode).toBe(1);
    expect(h.errors.join('\n')).toMatch(/at least 12 characters/);
  });

  it('prints usage and exits 0 for `help`', async () => {
    const h = makeHarness();
    const result = await runBackupCli(['help'], h.io);
    expect(result.exitCode).toBe(0);
    expect(h.logs.join('\n')).toMatch(/skytwin-backup/);
  });

  it('rejects an unknown subcommand', async () => {
    const h = makeHarness();
    const result = await runBackupCli(['frobnicate'], h.io);
    expect(result.exitCode).toBe(1);
    expect(h.errors.join('\n')).toMatch(/unknown subcommand/);
  });
});
