import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLegacyWatchWorkflowReconciliation } from '../legacy-watch-workflow-reconciliation.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('startLegacyWatchWorkflowReconciliation', () => {
  it('runs immediately, remains bounded, and retries on an unrefd interval', async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({
        legacyWatchesMigrated: 2,
        activeWorkflowProjectionsMaterialized: 1,
        mayHaveMore: false,
      });
    const logger = { info: vi.fn(), warn: vi.fn() };

    const stop = startLegacyWatchWorkflowReconciliation({
      logger,
      intervalMs: 1_000,
      batchSize: 3,
      reconcileBatch: reconcile,
    });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(reconcile).toHaveBeenLastCalledWith({ limit: 3 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('later tick'), {
      error: 'temporary',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('completed'), {
      legacyWatchesMigrated: 2,
      activeWorkflowProjectionsMaterialized: 1,
      mayHaveMore: false,
    });
    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('never overlaps a slow batch', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const reconcile = vi.fn(async () => {
      await pending;
      return {
        legacyWatchesMigrated: 0,
        activeWorkflowProjectionsMaterialized: 0,
        mayHaveMore: false,
      };
    });
    const stop = startLegacyWatchWorkflowReconciliation({
      logger: { info: vi.fn(), warn: vi.fn() },
      intervalMs: 10,
      reconcileBatch: reconcile,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    stop();
  });

  it('yields and drains consecutive bounded batches while work remains', async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn()
      .mockResolvedValueOnce({
        legacyWatchesMigrated: 1,
        activeWorkflowProjectionsMaterialized: 0,
        mayHaveMore: true,
      })
      .mockResolvedValueOnce({
        legacyWatchesMigrated: 1,
        activeWorkflowProjectionsMaterialized: 0,
        mayHaveMore: false,
      });
    const stop = startLegacyWatchWorkflowReconciliation({
      logger: { info: vi.fn(), warn: vi.fn() },
      intervalMs: 30_000,
      batchSize: 1,
      reconcileBatch: reconcile,
    });

    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(2);
    stop();
  });
});
