#!/usr/bin/env node
/**
 * skytwin-backup — export/restore a user's SkyTwin data to an encrypted file (#400).
 *
 *   skytwin-backup export  --user <userId> --out <file>
 *   skytwin-backup restore <archive>
 *
 * The passphrase is NEVER a CLI argument — argv lands in `ps` output and shell
 * history. It is read from the SKYTWIN_BACKUP_PASSPHRASE environment variable.
 *
 * The orchestration lives in `runBackupCli`, a pure-ish function that takes its
 * IO (read file, write file, log) as injected callbacks so it is unit-testable
 * without a real DB, filesystem, or process. The shebang entry at the bottom
 * wires the real implementations and is skipped under test (import-only).
 */

import { closePool } from '../connection.js';
import { collectBackup, restoreBackup } from '../backup/backup.js';
import {
  encodeArchive,
  decodeArchive,
  MIN_ARCHIVE_PASSPHRASE_LENGTH,
} from '../backup/archive.js';

/** Injected IO so the orchestration is testable without a real environment. */
export interface BackupCliIo {
  /** Read a file as a Buffer (rejects if missing). */
  readFile: (path: string) => Promise<Buffer>;
  /** Write a Buffer to a file. */
  writeFile: (path: string, data: Buffer) => Promise<void>;
  /** Resolve the backup passphrase (from env). */
  getPassphrase: () => string | undefined;
  /** Backup-data layer (swapped for a fake in tests). */
  collectBackup: typeof collectBackup;
  restoreBackup: typeof restoreBackup;
  encodeArchive: typeof encodeArchive;
  decodeArchive: typeof decodeArchive;
  /** Normal output. */
  log: (line: string) => void;
  /** Error output. */
  error: (line: string) => void;
}

export interface CliResult {
  /** Process exit code: 0 success, non-zero failure. */
  exitCode: number;
}

const USAGE = `skytwin-backup — export/restore your SkyTwin data (encrypted)

Usage:
  skytwin-backup export --user <userId> --out <file>
  skytwin-backup restore <archive>

The passphrase is read from the SKYTWIN_BACKUP_PASSPHRASE environment variable
(min ${MIN_ARCHIVE_PASSPHRASE_LENGTH} characters). It is never accepted as a
command-line argument.`;

/**
 * Parse `--flag value` pairs out of an argv slice. Returns a flat map; flags
 * without a following value map to an empty string.
 */
function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== undefined && arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = '';
      }
    }
  }
  return flags;
}

/**
 * Run the backup CLI. Returns a `CliResult` rather than calling
 * `process.exit`, so the caller (and tests) control termination.
 */
export async function runBackupCli(argv: string[], io: BackupCliIo): Promise<CliResult> {
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    io.log(USAGE);
    return { exitCode: subcommand ? 0 : 1 };
  }

  const passphrase = io.getPassphrase();
  if (!passphrase) {
    io.error('SKYTWIN_BACKUP_PASSPHRASE is not set. Export and restore both require it.');
    return { exitCode: 1 };
  }
  if (passphrase.length < MIN_ARCHIVE_PASSPHRASE_LENGTH) {
    io.error(
      `SKYTWIN_BACKUP_PASSPHRASE must be at least ${MIN_ARCHIVE_PASSPHRASE_LENGTH} characters.`,
    );
    return { exitCode: 1 };
  }

  if (subcommand === 'export') {
    const flags = parseFlags(rest);
    const userId = flags.user;
    const out = flags.out;
    if (!userId || !out) {
      io.error('export requires --user <userId> and --out <file>');
      io.error(USAGE);
      return { exitCode: 1 };
    }

    const result = await io.collectBackup(userId);
    if (!result.success) {
      io.error(`export failed: ${result.message}`);
      return { exitCode: 1 };
    }

    const json = JSON.stringify(result.data);
    const archive = await io.encodeArchive(json, passphrase);
    await io.writeFile(out, archive);

    const d = result.data;
    io.log(
      `Exported user ${userId} → ${out} (${archive.length} bytes, encrypted): ` +
        `${d.preferences.length} preferences, ${d.decisions.length} decisions, ` +
        `${d.twinProfileVersions.length} profile versions.`,
    );
    return { exitCode: 0 };
  }

  if (subcommand === 'restore') {
    const archivePath = rest.find((a) => !a.startsWith('--'));
    if (!archivePath) {
      io.error('restore requires an <archive> path');
      io.error(USAGE);
      return { exitCode: 1 };
    }

    let archive: Buffer;
    try {
      archive = await io.readFile(archivePath);
    } catch (err) {
      io.error(`could not read ${archivePath}: ${err instanceof Error ? err.message : String(err)}`);
      return { exitCode: 1 };
    }

    const decoded = await io.decodeArchive(archive, passphrase);
    if (!decoded.success) {
      io.error(`restore failed: ${decoded.message}`);
      return { exitCode: 1 };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded.json);
    } catch {
      io.error('restore failed: decrypted payload is not valid JSON');
      return { exitCode: 1 };
    }

    const result = await io.restoreBackup(parsed);
    if (!result.success) {
      io.error(`restore failed: ${result.message}`);
      return { exitCode: 1 };
    }

    const summary = Object.entries(result.summary.counts)
      .map(([table, n]) => `${table} (${n})`)
      .join(', ');
    io.log(`Restored ${result.summary.total} rows: ${summary}`);
    return { exitCode: 0 };
  }

  io.error(`unknown subcommand: ${subcommand}`);
  io.error(USAGE);
  return { exitCode: 1 };
}

/**
 * Detect whether this module is the program entry point (was run directly,
 * not imported). Under vitest / when imported as a library, this is false and
 * the side-effecting block below is skipped.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // import.meta.url is a file:// URL; compare against the resolved argv[1].
  return import.meta.url === new URL(`file://${entry}`).href || import.meta.url.endsWith(entry);
}

if (isMainModule()) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const io: BackupCliIo = {
    readFile: (path) => readFile(path),
    writeFile: (path, data) => writeFile(path, data),
    getPassphrase: () => process.env.SKYTWIN_BACKUP_PASSPHRASE,
    collectBackup,
    restoreBackup,
    encodeArchive,
    decodeArchive,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };

  const result = await runBackupCli(process.argv.slice(2), io);
  await closePool().catch(() => {
    /* best-effort pool shutdown; never mask the CLI's own exit code */
  });
  process.exit(result.exitCode);
}
