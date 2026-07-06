export {
  FS_DENYLIST_PATHS,
  FS_DENYLIST_PATTERNS,
  isDenied,
} from './denylist.js';
export type { IsDeniedOptions } from './denylist.js';

export {
  DEFAULT_ALLOWLIST_RELATIVE,
  expandAllowlist,
} from './allowlist.js';

export {
  ResourceGovernor,
} from './governor.js';
export type {
  ResourceGovernorOptions,
  ResourceGovernorState,
  ResourceGovernorPort,
  PauseReason,
} from './governor.js';

export {
  ElectronIdleDetector,
  MockIdleDetector,
  EventDrivenIdleDetector,
} from './idle-detector.js';
export type { IdleDetectorPort } from './idle-detector.js';

export {
  DEFAULT_EXTRACTORS,
  extractFile,
  packageJsonExtractor,
  gitConfigExtractor,
  globalGitConfigExtractor,
  pyprojectTomlExtractor,
  requirementsTxtExtractor,
  cargoTomlExtractor,
  goModExtractor,
  readmeSkipExtractor,
  isReadmeFile,
  getSkipReason,
} from './extractor.js';
export type {
  ExtractedFileMetadata,
  FileTypeExtractor,
} from './extractor.js';

export { IdleMiner } from './miner.js';
export type { MinerOptions } from './miner.js';

export { startIdleMiner } from './runtime.js';
export type { IdleMinerHandle, StartIdleMinerOptions } from './runtime.js';

export { SnapshotFileStore } from './snapshot-store.js';
export type { SnapshotFileStoreOptions } from './snapshot-store.js';

export { toIngestEvent, createHttpSignalEmitter } from './ingest-adapter.js';
export type { HttpSignalEmitterOptions } from './ingest-adapter.js';

export type {
  FsScanRoot,
  RawSignal,
  ScanCursor,
  FileIndexEntry,
  FileIndexRepo,
  CursorRepo,
} from './types.js';
