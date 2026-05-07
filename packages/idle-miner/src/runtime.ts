import { ResourceGovernor } from './governor.js';
import type { ResourceGovernorOptions } from './governor.js';
import { ElectronIdleDetector } from './idle-detector.js';
import type { IdleDetectorPort } from './idle-detector.js';
import { IdleMiner } from './miner.js';
import type { MinerOptions } from './miner.js';

export interface IdleMinerHandle {
  stop(): void;
}

export interface StartIdleMinerOptions
  extends Omit<MinerOptions, 'governor'> {
  governorOptions?: Partial<ResourceGovernorOptions>;
  idleDetector?: IdleDetectorPort;
  batchMaxMs?: number;
}

export function startIdleMiner(options: StartIdleMinerOptions): IdleMinerHandle {
  const governor = new ResourceGovernor(options.governorOptions ?? {});
  const detector = options.idleDetector ?? new ElectronIdleDetector();
  const batchMaxMs = options.batchMaxMs ?? 10_000;

  const miner = new IdleMiner({
    roots: options.roots,
    governor,
    extractors: options.extractors,
    signalEmitter: options.signalEmitter,
    homedir: options.homedir,
    fileIndexRepo: options.fileIndexRepo,
    cursorRepo: options.cursorRepo,
    userId: options.userId,
  });

  let activeBatch: Promise<void> | null = null;
  let stopped = false;

  detector.onIdle(() => {
    if (stopped || activeBatch !== null) return;
    const timeout = setTimeout(() => {
      miner.stop();
    }, batchMaxMs);
    activeBatch = miner.scanBatch().finally(() => {
      clearTimeout(timeout);
      activeBatch = null;
    });
  });

  detector.onActive(() => {
    miner.stop();
    governor.reportInputEvent();
  });

  detector.start();

  return {
    stop() {
      stopped = true;
      miner.stop();
      detector.stop();
    },
  };
}
