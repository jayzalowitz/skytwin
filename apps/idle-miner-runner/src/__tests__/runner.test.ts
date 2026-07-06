import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventDrivenIdleDetector, SnapshotFileStore } from '@skytwin/idle-miner';
import type { IdleMinerHandle, StartIdleMinerOptions } from '@skytwin/idle-miner';
import { createIdleMinerRunner, toScanRoots, type RunnerDeps } from '../runner.js';
import type { RunnerConfig } from '../config.js';

const silentLogger = { info: () => {}, warn: () => {} };

type StartIdleMinerFn = NonNullable<RunnerDeps['startIdleMinerFn']>;

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
  let handleStop: Mock<IdleMinerHandle['stop']>;
  let handleDrain: Mock<IdleMinerHandle['drain']>;
  let startFn: Mock<StartIdleMinerFn>;
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
    handleDrain = vi.fn().mockResolvedValue(undefined);
    lastOptions = undefined;
    startFn = vi.fn((opts: StartIdleMinerOptions) => {
      lastOptions = opts;
      return { stop: handleStop, drain: handleDrain };
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

  it('shutdown() stops the miner, DRAINS before flushing, halts the detector — idempotently', async () => {
    const closeSpy = vi.spyOn(store, 'close');
    const onIdle = vi.fn();
    detector.onIdle(onIdle);
    const runner = createIdleMinerRunner(config(), deps());

    await runner.shutdown();
    expect(handleStop).toHaveBeenCalledTimes(1);
    expect(handleDrain).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // Drain the in-flight batch BEFORE flushing the index — no mid-file work lost.
    expect(handleDrain.mock.invocationCallOrder[0]).toBeLessThan(closeSpy.mock.invocationCallOrder[0]!);

    // Detector is stopped: further control lines are inert.
    runner.handleControlLine('idle');
    expect(onIdle).not.toHaveBeenCalled();

    // Idempotent.
    await runner.shutdown();
    expect(handleStop).toHaveBeenCalledTimes(1);
  });

  it('ignores the "stop" control line at the runner level (process exit is the entrypoint\'s job)', () => {
    const runner = createIdleMinerRunner(config(), deps());
    runner.handleControlLine('stop');
    expect(handleStop).not.toHaveBeenCalled();
  });
});
