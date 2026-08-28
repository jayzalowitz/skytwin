import {
  startIdleMiner,
  SnapshotFileStore,
  createHttpSignalEmitter,
  EventDrivenIdleDetector,
  expandAllowlist,
  DEFAULT_EXTRACTORS,
  type IdleMinerHandle,
  type StartIdleMinerOptions,
  type FsScanRoot,
} from '@skytwin/idle-miner';
import type { RunnerConfig } from './config.js';

export interface RunnerLogger {
  info: (msg: string) => void;
  warn: (msg: string, err?: unknown) => void;
}

export interface RunnerDeps {
  /** Injectable so assembly + lifecycle is verified without scanning the FS. */
  startIdleMinerFn?: (options: StartIdleMinerOptions) => IdleMinerHandle;
  detector?: EventDrivenIdleDetector;
  store?: SnapshotFileStore;
  logger?: RunnerLogger;
}

export interface IdleMinerRunner {
  /**
   * Feed one control line from the parent (stdin): `idle` | `active`. `stop` and
   * process exit are owned by the entrypoint (`index.ts`), not the runner.
   */
  handleControlLine(line: string): void;
  /**
   * Stop the miner, DRAIN any in-flight scan batch, then flush the device-local
   * index. Async + idempotent — awaiting it guarantees no mid-file work is lost
   * on shutdown.
   */
  shutdown(): Promise<void>;
}

/**
 * Map allowlisted absolute paths to `FsScanRoot` descriptors. The absolute path
 * is the stable, unique `id` — so the device-local file-index keys stay stable
 * across runs (a moved home dir is a different device / different store anyway).
 */
export function toScanRoots(paths: string[], userId: string): FsScanRoot[] {
  // `FsScanRoot` also carries DB-row tracking fields (byte/file counters,
  // timestamps). The miner's in-process scan path keys off id / rootPath /
  // userId / enabled / source; the counters are enforced live by the
  // `ResourceGovernor`, and only the file index (`SnapshotFileStore`) is
  // persisted across restarts. Fresh zero/epoch defaults are correct for an
  // in-memory descriptor.
  const epoch = new Date(0);
  return paths.map((rootPath) => ({
    id: rootPath,
    userId,
    rootPath,
    enabled: true,
    source: 'fs' as const,
    lastScanCompleted: false,
    bytesToday: 0,
    bytesTotal: 0,
    filesTotal: 0,
    rollingDayStartedAt: epoch.toISOString(),
    createdAt: epoch,
    updatedAt: epoch,
  }));
}

const defaultLogger: RunnerLogger = {
  info: (msg) => console.info(`[idle-miner-runner] ${msg}`),
  warn: (msg, err) => console.warn(`[idle-miner-runner] ${msg}`, err ?? ''),
};

/**
 * Assemble a running idle-miner from validated config and return a small control
 * surface. The detector is EVENT-DRIVEN: this process receives idle / active
 * transitions from its parent (the desktop, which owns OS idle detection) over
 * stdin, because a plain Node child has no Electron `powerMonitor`. The miner
 * only scans while idle and yields the moment the parent reports activity.
 */
export function createIdleMinerRunner(config: RunnerConfig, deps: RunnerDeps = {}): IdleMinerRunner {
  const log = deps.logger ?? defaultLogger;
  const startFn = deps.startIdleMinerFn ?? startIdleMiner;
  const detector = deps.detector ?? new EventDrivenIdleDetector();
  const store = deps.store ?? new SnapshotFileStore(config.dataDir);
  // Posts to the local API's ingest endpoint exactly like the worker's
  // `forwardSignalToApi`, carrying the same per-install loopback service
  // credential. This process runs on the same host as the API (spawned by the
  // desktop), and a packaged build runs the API under NODE_ENV=production with
  // the localhost auth bypass explicitly off — so the token is what makes the
  // post succeed. When it is absent (dev, bypass on) the emitter omits the
  // header and behaves exactly as before.
  const emitter = createHttpSignalEmitter({
    ingestUrl: config.ingestUrl,
    userId: config.userId,
    ...(config.serviceToken !== undefined ? { serviceToken: config.serviceToken } : {}),
  });

  const roots = toScanRoots(expandAllowlist(config.homedir), config.userId);
  const handle = startFn({
    roots,
    extractors: DEFAULT_EXTRACTORS,
    signalEmitter: emitter,
    homedir: config.homedir,
    fileIndexRepo: store,
    cursorRepo: store,
    userId: config.userId,
    idleDetector: detector,
  });
  detector.start();
  log.info(`started for user ${config.userId}: ${roots.length} scan root(s) under ${config.homedir}`);

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    detector.stop(); // no new idle triggers
    handle.stop(); // stop the current batch + prevent new ones
    await handle.drain(); // let the in-flight batch settle before we flush
    store.close(); // flush the device-local index so we don't re-scan on restart
    log.info('stopped');
  };

  return {
    handleControlLine(line: string): void {
      switch (line.trim().toLowerCase()) {
        case 'idle':
          detector.setIdle();
          break;
        case 'active':
          detector.setActive();
          break;
        default:
          // Ignore blank / unknown control lines. `stop` + process exit are
          // owned by the entrypoint (index.ts), not the runner.
          break;
      }
    },
    shutdown,
  };
}
