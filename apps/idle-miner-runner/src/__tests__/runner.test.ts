import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventDrivenIdleDetector, SnapshotFileStore } from '@skytwin/idle-miner';
import type { StartIdleMinerOptions } from '@skytwin/idle-miner';
import { createIdleMinerRunner, toScanRoots, type RunnerDeps } from '../runner.js';
import type { RunnerConfig } from '../config.js';

const silentLogger = { info: () => {}, warn: () => {} };

describe('toScanRoots', () => {
  it('maps paths to fs FsScanRoots with the path as stable id', () => {
    const roots = toScanRoots(['/home/u/Documents', '/home/u/Code'], 'user-1');
    expect(roots).toHaveLength(2);
    expect(roots[0]).toMatchObject({
      id: '/home/u/Documents',
      userId: 'user-1',
      rootPath: '/home/u/Documents',
      enabled: true,
      source: 'fs',
      lastScanCompleted: false,
    });
    expect(roots[1]).toMatchObject({ id: '/home/u/Code', rootPath: '/home/u/Code', source: 'fs' });
  });
});

describe('createIdleMinerRunner', () => {
  let home: string;
  let dataDir: string;
  let store: SnapshotFileStore;
  let detector: EventDrivenIdleDetector;
  let handleStop: ReturnType<typeof vi.fn>;
  let startFn: ReturnType<typeof vi.fn>;
  let lastOptions: StartIdleMinerOptions | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'idle-home-'));
    // Two allowlisted dirs exist; the rest don't → deterministic root set.
    mkdirSync(join(home, 'Documents'));
    mkdirSync(join(home, 'Code'));
    dataDir = mkdtempSync(join(tmpdir(), 'idle-data-'));
    store = new SnapshotFileStore(dataDir);
    detector = new EventDrivenIdleDetector();
    handleStop = vi.fn();
    lastOptions = undefined;
    startFn = vi.fn((opts: StartIdleMinerOptions) => {
      lastOptions = opts;
      return { stop: handleStop };
    });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const config: () => RunnerConfig = () => ({
    userId: 'user-1',
    ingestUrl: 'http://localhost:3200/api/events/ingest',
    dataDir,
    homedir: home,
  });
  const deps = (): RunnerDeps => ({ startIdleMinerFn: startFn, detector, store, logger: silentLogger });

  it('assembles the miner with allowlisted roots, the injected detector, and the store as both repos', () => {
    createIdleMinerRunner(config(), deps());
    expect(startFn).toHaveBeenCalledTimes(1);
    expect(lastOptions?.userId).toBe('user-1');
    expect(lastOptions?.idleDetector).toBe(detector);
    expect(lastOptions?.fileIndexRepo).toBe(store);
    expect(lastOptions?.cursorRepo).toBe(store);
    expect(lastOptions?.roots.map((r) => r.rootPath).sort()).toEqual(
      [join(home, 'Code'), join(home, 'Documents')].sort(),
    );
  });

  it('starts the detector so control lines take effect', () => {
    const onIdle = vi.fn();
    const onActive = vi.fn();
    detector.onIdle(onIdle);
    detector.onActive(onActive);
    const runner = createIdleMinerRunner(config(), deps());

    runner.handleControlLine('idle');
    expect(onIdle).toHaveBeenCalledTimes(1);
    runner.handleControlLine('active');
    expect(onActive).toHaveBeenCalledTimes(1);
  });

  it('maps control words case/whitespace-insensitively and ignores unknown lines', () => {
    const onIdle = vi.fn();
    detector.onIdle(onIdle);
    const runner = createIdleMinerRunner(config(), deps());
    runner.handleControlLine('  IDLE  ');
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(() => runner.handleControlLine('garbage')).not.toThrow();
    expect(() => runner.handleControlLine('')).not.toThrow();
  });

  it('shutdown() stops the miner, flushes the store, and halts the detector — idempotently', () => {
    const closeSpy = vi.spyOn(store, 'close');
    const onIdle = vi.fn();
    detector.onIdle(onIdle);
    const runner = createIdleMinerRunner(config(), deps());

    runner.shutdown();
    expect(handleStop).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Detector is stopped: further control lines are inert.
    runner.handleControlLine('idle');
    expect(onIdle).not.toHaveBeenCalled();

    // Idempotent.
    runner.shutdown();
    expect(handleStop).toHaveBeenCalledTimes(1);
  });

  it('the "stop" control line triggers shutdown', () => {
    const runner = createIdleMinerRunner(config(), deps());
    runner.handleControlLine('stop');
    expect(handleStop).toHaveBeenCalledTimes(1);
  });
});
