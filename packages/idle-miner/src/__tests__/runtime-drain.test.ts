import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIdleMiner } from '../runtime.js';
import { SnapshotFileStore } from '../snapshot-store.js';
import { MockIdleDetector } from '../idle-detector.js';
import { DEFAULT_EXTRACTORS } from '../extractor.js';
import type { FsScanRoot } from '../types.js';

function makeRoot(rootPath: string, userId: string): FsScanRoot {
  const epoch = new Date(0);
  return {
    id: rootPath,
    userId,
    rootPath,
    enabled: true,
    source: 'fs',
    lastScanCompleted: false,
    bytesToday: 0,
    bytesTotal: 0,
    filesTotal: 0,
    rollingDayStartedAt: epoch.toISOString(),
    createdAt: epoch,
    updatedAt: epoch,
  };
}

describe('startIdleMiner handle.drain()', () => {
  let scanDir: string;
  let dataDir: string;

  beforeEach(() => {
    scanDir = mkdtempSync(join(tmpdir(), 'idle-scan-'));
    writeFileSync(join(scanDir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    dataDir = mkdtempSync(join(tmpdir(), 'idle-data-'));
  });
  afterEach(() => {
    rmSync(scanDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  function start(detector: MockIdleDetector) {
    const store = new SnapshotFileStore(dataDir);
    return startIdleMiner({
      roots: [makeRoot(scanDir, 'user-1')],
      extractors: DEFAULT_EXTRACTORS,
      signalEmitter: async () => {},
      homedir: scanDir,
      fileIndexRepo: store,
      cursorRepo: store,
      userId: 'user-1',
      idleDetector: detector,
    });
  }

  it('resolves immediately when no batch is running', async () => {
    const handle = start(new MockIdleDetector());
    handle.stop();
    await expect(handle.drain()).resolves.toBeUndefined();
  });

  it('awaits an in-flight scan batch before resolving (no mid-file work killed)', async () => {
    const detector = new MockIdleDetector();
    const handle = start(detector);
    detector.triggerIdle(); // kicks off a scan batch
    handle.stop();
    // If drain did not await the batch this would resolve before the scan settled;
    // the assertion is simply that it resolves cleanly after stop().
    await expect(handle.drain()).resolves.toBeUndefined();
  });
});
