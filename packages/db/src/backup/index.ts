/**
 * @skytwin/db backup module (#400).
 *
 * Public surface for the encrypted backup/restore flow used by the
 * `skytwin-backup` CLI and any in-app data-export wiring.
 */

export {
  encodeArchive,
  decodeArchive,
  MIN_ARCHIVE_PASSPHRASE_LENGTH,
} from './archive.js';
export type { DecodeArchiveResult } from './archive.js';

export {
  collectBackup,
  restoreBackup,
  validateBackupData,
  BACKUP_SCHEMA_VERSION,
} from './backup.js';
export type {
  BackupData,
  DecisionBundle,
  CollectBackupResult,
  RestoreBackupResult,
  RestoreSummary,
} from './backup.js';
