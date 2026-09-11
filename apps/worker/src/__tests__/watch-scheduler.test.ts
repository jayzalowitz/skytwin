import { describe, it, expect, vi } from 'vitest';
import type { ClaimedWatchSlot, SignalRow } from '@skytwin/db';
import type { Watch } from '@skytwin/shared-types';
import {
  shouldRunWatchScheduler,
  toMatchable,
  evaluateWatch,
  runWatchSchedulerJob,
  WATCH_SCHEDULER_INTERVAL_MS,
} from '../jobs/watch-scheduler.js';

function watch(over: Partial<Watch> = {}): Watch {
  return {
    id: 'w1',
    userId: 'u1',
    name: 'Client mail',
    sourceText: 'flag mail from finance@acme.com',
    cadence: 'daily',
    hourOfDay: 8,
    filter: { sources: ['gmail'], fromContains: ['finance@acme.com'] },
    action: 'digest',
    status: 'active',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    lastRunAt: null,
    nextRunAt: new Date('2026-07-05T08:00:00Z'),
    ...over,
  };
}

function signal(over: Partial<SignalRow> = {}): SignalRow {
  return {
    id: 's1',
    user_id: 'u1',
    source: 'gmail',
    type: 'message',
    domain: 'general',
    data: { from: 'finance@acme.com', subject: 'Q3 budget' },
    timestamp: new Date('2026-07-05T07:00:00Z'),
    retention_until: new Date('2026-08-05T00:00:00Z'),
    created_at: new Date('2026-07-05T07:00:00Z'),
    source_signal_id: null,
    connector_account_id: null,
    resource_ref_id: null,
    ...over,
  };
}

describe('shouldRunWatchScheduler', () => {
  it('is false when disabled', () => {
    expect(shouldRunWatchScheduler({ enabled: false, nowMs: 1e9, lastRunAt: 0 })).toBe(false);
  });
  it('is false before the interval elapses', () => {
    expect(shouldRunWatchScheduler({ enabled: true, nowMs: 1000, lastRunAt: 999, intervalMs: 60_000 })).toBe(false);
  });
  it('is true once the interval elapses', () => {
    expect(shouldRunWatchScheduler({ enabled: true, nowMs: 61_000, lastRunAt: 0, intervalMs: 60_000 })).toBe(true);
  });
});

describe('toMatchable', () => {
  it('extracts source, sender, and searchable text', () => {
    const m = toMatchable(signal({ data: { organizer: 'boss@x.com', title: 'Sync', description: 'agenda' } }));
    expect(m.source).toBe('gmail');
    expect(m.from).toBe('boss@x.com'); // falls back to organizer
    expect(m.text).toContain('Sync');
    expect(m.text).toContain('agenda');
  });
});

describe('evaluateWatch', () => {
  const windowStart = new Date('2026-07-05T00:00:00Z');
  const windowEnd = new Date('2026-07-05T12:00:00Z');

  it('matches signals inside the window that satisfy the filter', () => {
    const signals = [
      signal({ id: 'a' }), // matches (gmail, from finance@acme.com)
      signal({ id: 'b', data: { from: 'stranger@x.com', subject: 'hi' } }), // wrong sender
      signal({ id: 'c', source: 'voice' }), // wrong source
    ];
    const r = evaluateWatch(watch(), signals, windowStart, windowEnd);
    expect(r.matchedCount).toBe(1);
    expect(r.matchedRefs).toEqual(['a']);
    expect(r.summary).toMatch(/1 update: Q3 budget/);
  });

  it('excludes signals at or before the window start', () => {
    const old = signal({ id: 'old', timestamp: new Date('2026-07-04T00:00:00Z') });
    expect(evaluateWatch(watch(), [old], windowStart, windowEnd).matchedCount).toBe(0);
  });

  it('excludes signals after the window end (claimed later, counted next run)', () => {
    const future = signal({ id: 'future', timestamp: new Date('2026-07-05T13:00:00Z') });
    expect(evaluateWatch(watch(), [future], windowStart, windowEnd).matchedCount).toBe(0);
  });

  it('includes a signal exactly at the window end (boundary counted once)', () => {
    const boundary = signal({ id: 'edge', timestamp: windowEnd });
    expect(evaluateWatch(watch(), [boundary], windowStart, windowEnd).matchedCount).toBe(1);
  });

  it('caps stored refs at MAX_STORED_REFS while matchedCount stays the true total', () => {
    const many = Array.from({ length: 250 }, (_, i) => signal({ id: `m${i}` }));
    const r = evaluateWatch(watch(), many, windowStart, windowEnd);
    expect(r.matchedCount).toBe(250);
    expect(r.matchedRefs).toHaveLength(200);
  });

  it('a notify watch summarizes tersely', () => {
    const r = evaluateWatch(watch({ action: 'notify' }), [signal({ id: 'a' })], windowStart, windowEnd);
    expect(r.summary).toMatch(/New match: Q3 budget/);
  });

  it('no matches → count 0, empty summary', () => {
    const r = evaluateWatch(watch(), [signal({ data: { from: 'nobody@x.com' } })], windowStart, windowEnd);
    expect(r.matchedCount).toBe(0);
    expect(r.summary).toBe('');
  });
});

describe('runWatchSchedulerJob', () => {
  const NOW = new Date('2026-07-05T09:00:00Z');
  const WINDOW_START = new Date('2026-07-05T07:00:00Z');

  function claimedSlot(over: Partial<ClaimedWatchSlot> = {}): ClaimedWatchSlot {
    const source = watch();
    return {
      id: 'slot-1',
      watchId: source.id,
      userId: source.userId,
      spec: {
        name: source.name,
        cadence: source.cadence,
        hourOfDay: source.hourOfDay,
        filter: source.filter,
        action: source.action,
      },
      scheduledFor: new Date('2026-07-05T08:00:00Z'),
      windowStart: WINDOW_START,
      windowEnd: NOW,
      leaseToken: 'lease-1',
      attemptCount: 1,
      ...over,
    };
  }

  function runRepoWith(slots: Array<ClaimedWatchSlot | null>) {
    return {
      claimNextDueSlot: vi.fn()
        .mockImplementationOnce(async () => slots.shift() ?? null)
        .mockImplementation(async () => slots.shift() ?? null),
      completeSlot: vi.fn().mockResolvedValue(true),
      failSlot: vi.fn().mockResolvedValue('retry_scheduled' as const),
      pruneZeroMatchSlots: vi.fn().mockResolvedValue(0),
    };
  }

  it('claims and completes a durable slot when its persisted window matches', async () => {
    const slot = claimedSlot();
    const runRepo = runRepoWith([slot, null]);
    const listInWindow = vi.fn().mockResolvedValue([
      signal({ id: 'a', timestamp: new Date('2026-07-05T08:00:00Z') }),
    ]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: { listInWindow },
    });
    expect(listInWindow).toHaveBeenCalledWith(slot.userId, WINDOW_START, NOW);
    expect(runRepo.completeSlot).toHaveBeenCalledWith({
      id: slot.id,
      leaseToken: slot.leaseToken,
      matchedCount: 1,
      summary: expect.stringContaining('Q3 budget'),
      matchedRefs: ['a'],
    });
    expect(runRepo.pruneZeroMatchSlots).toHaveBeenCalledWith(30, 100);
  });

  it('completes zero-match slots so the persisted schedule has no gaps', async () => {
    const slot = claimedSlot();
    const runRepo = runRepoWith([slot, null]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: { listInWindow: vi.fn().mockResolvedValue([]) },
    });
    expect(runRepo.completeSlot).toHaveBeenCalledWith(expect.objectContaining({
      id: slot.id,
      matchedCount: 0,
      summary: '',
      matchedRefs: [],
    }));
  });

  it('does not retry or fail a completion after losing its lease', async () => {
    const runRepo = runRepoWith([claimedSlot(), null]);
    runRepo.completeSlot.mockResolvedValue(false);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: { listInWindow: vi.fn().mockResolvedValue([signal()]) },
    });
    expect(runRepo.completeSlot).toHaveBeenCalledTimes(1);
    expect(runRepo.failSlot).not.toHaveBeenCalled();
  });

  it('uses the immutable slot window rather than recalculating a lookback', async () => {
    const slot = claimedSlot({
      windowStart: new Date('2026-07-05T08:15:00Z'),
      windowEnd: new Date('2026-07-05T08:45:00Z'),
    });
    const runRepo = runRepoWith([slot, null]);
    const listInWindow = vi.fn().mockResolvedValue([]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: { listInWindow },
    });
    expect(listInWindow).toHaveBeenCalledWith(slot.userId, slot.windowStart, slot.windowEnd);
  });

  it('records a failed attempt and continues to the next durable slot', async () => {
    const bad = claimedSlot({ id: 'bad-slot', leaseToken: 'bad-lease' });
    const good = claimedSlot({ id: 'good-slot', leaseToken: 'good-lease' });
    const runRepo = runRepoWith([bad, good, null]);
    const listInWindow = vi
      .fn()
      .mockRejectedValueOnce(new Error('signal read failed'))
      .mockResolvedValueOnce([signal({ id: 'a' })]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: { listInWindow },
    });
    expect(runRepo.failSlot).toHaveBeenCalledWith({
      id: bad.id,
      leaseToken: bad.leaseToken,
      retryDelayMs: WATCH_SCHEDULER_INTERVAL_MS,
      error: 'signal read failed',
    });
    expect(runRepo.completeSlot).toHaveBeenCalledWith(expect.objectContaining({ id: good.id }));
  });
});
