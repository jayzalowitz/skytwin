import { describe, it, expect, vi } from 'vitest';
import { createPruneThrottle } from '../label-signal-pruner.js';

// The throttle gates the per-user `email_label_signals` prune to "once per
// minIntervalMs" inside a worker process. The actual DB call is injected so
// these tests don't need a live CRDB. Issue #122 follow-up — protects
// against unbounded table growth.
describe('createPruneThrottle', () => {
  it('runs the prune on the first call for a user', async () => {
    const runner = vi.fn().mockResolvedValue(7);
    const throttle = createPruneThrottle(runner, () => undefined);

    const result = await throttle('user-1');
    expect(result).toBe(7);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith('user-1');
  });

  it('skips subsequent calls within minIntervalMs', async () => {
    let now = 1_000_000;
    const runner = vi.fn().mockResolvedValue(3);
    const throttle = createPruneThrottle(runner, () => undefined, {
      minIntervalMs: 60_000,
      now: () => now,
    });

    expect(await throttle('user-1')).toBe(3);
    now += 30_000; // 30s later, well under the 60s gate
    expect(await throttle('user-1')).toBeNull();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('runs again after minIntervalMs has elapsed', async () => {
    let now = 1_000_000;
    const runner = vi.fn().mockResolvedValue(5);
    const throttle = createPruneThrottle(runner, () => undefined, {
      minIntervalMs: 60_000,
      now: () => now,
    });

    expect(await throttle('user-1')).toBe(5);
    now += 60_001;
    expect(await throttle('user-1')).toBe(5);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('throttles per-user (one user being throttled does not block others)', async () => {
    let now = 1_000_000;
    const runner = vi.fn().mockResolvedValue(1);
    const throttle = createPruneThrottle(runner, () => undefined, {
      minIntervalMs: 60_000,
      now: () => now,
    });

    expect(await throttle('user-1')).toBe(1);
    expect(await throttle('user-2')).toBe(1);
    expect(await throttle('user-1')).toBeNull(); // throttled
    expect(await throttle('user-2')).toBeNull(); // throttled
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('swallows runner errors via onError and still updates the throttle', async () => {
    let now = 1_000_000;
    const onError = vi.fn();
    const runner = vi.fn().mockRejectedValue(new Error('db down'));
    const throttle = createPruneThrottle(runner, onError, {
      minIntervalMs: 60_000,
      now: () => now,
    });

    expect(await throttle('user-1')).toBeNull(); // null because error swallowed
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('user-1', expect.any(Error));

    // Throttle stamped before await, so the next call within the interval
    // is still skipped — we don't hammer a failing DB on every poll cycle.
    expect(await throttle('user-1')).toBeNull();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('stamps the timestamp before awaiting (no double-fire from concurrent polls)', async () => {
    // Two pollUser calls landing inside the same tick must not both call
    // the runner — the throttle has to update its bookkeeping synchronously
    // even though the underlying call is async.
    let now = 1_000_000;
    let resolveRunner!: (v: number) => void;
    const runner = vi.fn().mockReturnValue(
      new Promise<number>((resolve) => {
        resolveRunner = resolve;
      }),
    );
    const throttle = createPruneThrottle(runner, () => undefined, {
      minIntervalMs: 60_000,
      now: () => now,
    });

    const first = throttle('user-1');
    const second = throttle('user-1'); // arrives before the first resolves

    resolveRunner(42);
    expect(await first).toBe(42);
    expect(await second).toBeNull(); // second was skipped synchronously
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('default minInterval is 24h', async () => {
    let now = 0;
    const runner = vi.fn().mockResolvedValue(0);
    const throttle = createPruneThrottle(runner, () => undefined, {
      now: () => now,
    });

    expect(await throttle('user-1')).toBe(0);
    now += 23 * 60 * 60 * 1000; // 23h later
    expect(await throttle('user-1')).toBeNull();
    now += 2 * 60 * 60 * 1000; // 25h total
    expect(await throttle('user-1')).toBe(0);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
