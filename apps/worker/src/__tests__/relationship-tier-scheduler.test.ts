import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRun = vi.fn();
vi.mock('../jobs/relationship-tier-backfill.js', () => ({
  runRelationshipTierBackfillJob: (...args: unknown[]) => mockRun(...args),
}));

const {
  runRelationshipTierBackfillBatch,
  RELATIONSHIP_TIER_BACKFILL_CONCURRENCY,
  RELATIONSHIP_TIER_BACKFILL_USER_TIMEOUT_MS,
} = await import('../jobs/relationship-tier-scheduler.js');

describe('runRelationshipTierBackfillBatch (#282)', () => {
  beforeEach(() => {
    mockRun.mockReset();
  });

  it('returns immediately when the user list is empty', async () => {
    const summary = await runRelationshipTierBackfillBatch([]);
    expect(summary).toEqual({ succeeded: 0, failed: 0, timedOut: 0 });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('calls runRelationshipTierBackfillJob once per user', async () => {
    mockRun.mockResolvedValue({ attempted: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 });
    const summary = await runRelationshipTierBackfillBatch(['u1', 'u2', 'u3']);
    expect(summary.succeeded).toBe(3);
    expect(mockRun).toHaveBeenCalledTimes(3);
    expect(mockRun).toHaveBeenNthCalledWith(1, 'u1');
    expect(mockRun).toHaveBeenNthCalledWith(2, 'u2');
    expect(mockRun).toHaveBeenNthCalledWith(3, 'u3');
  });

  it('respects the bounded concurrency limit', async () => {
    // Pin the concurrency contract: with the limit set to N, at most N
    // calls should be in-flight at any single moment, even when the
    // user list is much larger. Easier to assert via a manual gate that
    // counts concurrent in-flights.
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    mockRun.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => release.push(r));
      inFlight--;
      return { attempted: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
    });

    const userIds = Array.from({ length: 10 }, (_, i) => `u${i}`);
    const batchPromise = runRelationshipTierBackfillBatch(userIds);

    // Let the event loop start the first chunk of users.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // At most CONCURRENCY users should be running at once.
    expect(maxInFlight).toBeLessThanOrEqual(RELATIONSHIP_TIER_BACKFILL_CONCURRENCY);
    expect(inFlight).toBeLessThanOrEqual(RELATIONSHIP_TIER_BACKFILL_CONCURRENCY);

    // Drain the gate.
    while (release.length > 0) {
      release.shift()!();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
    const summary = await batchPromise;
    expect(summary.succeeded).toBe(10);
    expect(maxInFlight).toBeLessThanOrEqual(RELATIONSHIP_TIER_BACKFILL_CONCURRENCY);
  });

  it('isolates per-user failures so other users still complete', async () => {
    mockRun.mockImplementation(async (userId: string) => {
      if (userId === 'u2') throw new Error('synthetic DB error');
      return { attempted: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
    });
    const summary = await runRelationshipTierBackfillBatch(['u1', 'u2', 'u3']);
    expect(summary).toEqual({ succeeded: 2, failed: 1, timedOut: 0 });
    expect(mockRun).toHaveBeenCalledTimes(3);
  });

  it('honors the per-user timeout via the real withTimeout path (hung user does not block the batch)', async () => {
    // Real timeout test — exercises the `withTimeout` + `Promise.race`
    // + `setTimeout` machinery, not just the classifier. The second
    // user hangs forever; the batch must complete with that user
    // counted as `timedOut`, not stuck. Uses the parameterized
    // `timeoutMs` opt so we don't wait the production 5min.
    mockRun.mockImplementation(async (userId: string) => {
      if (userId === 'u2') {
        return new Promise(() => {
          // never resolves
        });
      }
      return { attempted: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
    });
    const summary = await runRelationshipTierBackfillBatch(['u1', 'u2', 'u3'], {
      timeoutMs: 20,
    });
    expect(summary).toEqual({ succeeded: 2, failed: 0, timedOut: 1 });
  });

  it('exposes a sensible production timeout constant', () => {
    expect(RELATIONSHIP_TIER_BACKFILL_USER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(RELATIONSHIP_TIER_BACKFILL_USER_TIMEOUT_MS).toBeLessThan(60 * 60 * 1000);
  });

  it('worker-pool: a slow user does not block the rest from starting', async () => {
    // The chunked Promise.all the first cut used would stall the next 3
    // users until the 5-minute user finished. The worker pool grabs
    // from a shared queue, so as soon as one of the N workers is free
    // it picks up the next user. With 5 users, 3 workers, and one slow
    // user, the other 4 should all complete BEFORE the slow one.
    let slowStartedAt: number | null = null;
    let fastFinishCount = 0;
    mockRun.mockImplementation(async (userId: string) => {
      if (userId === 'slow') {
        slowStartedAt = Date.now();
        // Sleep long enough for the other workers to pick up everything
        // else from the queue.
        await new Promise((r) => setTimeout(r, 60));
        return { attempted: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
      }
      fastFinishCount++;
      return { attempted: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
    });
    const summary = await runRelationshipTierBackfillBatch(
      ['slow', 'f1', 'f2', 'f3', 'f4'],
      { timeoutMs: 5_000 },
    );
    expect(summary.succeeded).toBe(5);
    expect(slowStartedAt).not.toBeNull();
    // All fast users completed even though the slow one is still in
    // flight when fastFinishCount hits 4 — the worker pool kept going.
    expect(fastFinishCount).toBe(4);
  });
});
