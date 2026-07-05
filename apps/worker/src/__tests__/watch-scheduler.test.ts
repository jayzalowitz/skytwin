import { describe, it, expect, vi } from 'vitest';
import type { SignalRow } from '@skytwin/db';
import type { Watch } from '@skytwin/shared-types';
import {
  shouldRunWatchScheduler,
  toMatchable,
  evaluateWatch,
  runWatchSchedulerJob,
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
  const getRecentWith = (rows: SignalRow[]) => vi.fn().mockResolvedValue(rows);
  const getLocaleUTC = () => vi.fn().mockResolvedValue({ language: null, timezone: 'UTC' });

  it('claims + writes a run and advances the next firing when a due watch matches', async () => {
    const claimDue = vi.fn().mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue({});
    await runWatchSchedulerJob({
      now: NOW,
      watchRepo: { listDue: vi.fn().mockResolvedValue([watch()]), claimDue },
      runRepo: { create },
      signalRepo: { getRecent: getRecentWith([signal({ id: 'a' })]) },
      userRepo: { getLocale: getLocaleUTC() },
    });
    expect(claimDue).toHaveBeenCalledTimes(1);
    // claimDue(id, seenNextRunAt, nextRunAt, ranAt) — the new next_run_at is future.
    expect((claimDue.mock.calls[0]![2] as Date).getTime()).toBeGreaterThan(NOW.getTime());
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].matchedRefs).toEqual(['a']);
  });

  it('advances the schedule even when nothing matched (no run row)', async () => {
    const claimDue = vi.fn().mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue({});
    await runWatchSchedulerJob({
      now: NOW,
      watchRepo: { listDue: vi.fn().mockResolvedValue([watch()]), claimDue },
      runRepo: { create },
      signalRepo: { getRecent: getRecentWith([]) }, // no signals
      userRepo: { getLocale: getLocaleUTC() },
    });
    expect(claimDue).toHaveBeenCalledTimes(1); // claimed (schedule advanced)
    expect(create).not.toHaveBeenCalled(); // but no run row
  });

  it('writes no run when it loses the claim (another worker took it)', async () => {
    const claimDue = vi.fn().mockResolvedValue(false); // lost the race
    const getRecent = getRecentWith([signal({ id: 'a' })]);
    const create = vi.fn().mockResolvedValue({});
    await runWatchSchedulerJob({
      now: NOW,
      watchRepo: { listDue: vi.fn().mockResolvedValue([watch()]), claimDue },
      runRepo: { create },
      signalRepo: { getRecent },
      userRepo: { getLocale: getLocaleUTC() },
    });
    expect(claimDue).toHaveBeenCalledTimes(1);
    // Evaluate-then-claim: getRecent runs BEFORE the claim (so a crash there
    // doesn't advance the schedule), but the loser discards its work — no run.
    expect(getRecent).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not digest signals from before a fresh watch was created', async () => {
    // Watch created 2h before NOW, never run. Its window floor is createdAt,
    // so a matching signal that predates creation must be excluded even though
    // getRecent's cadence lookback would otherwise reach it.
    const fresh = watch({ lastRunAt: null, createdAt: new Date('2026-07-05T07:00:00Z') });
    const claimDue = vi.fn().mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue({});
    await runWatchSchedulerJob({
      now: NOW, // 09:00Z
      watchRepo: { listDue: vi.fn().mockResolvedValue([fresh]), claimDue },
      runRepo: { create },
      signalRepo: {
        getRecent: getRecentWith([
          signal({ id: 'pre', timestamp: new Date('2026-07-05T06:00:00Z') }), // before createdAt
          signal({ id: 'post', timestamp: new Date('2026-07-05T08:00:00Z') }), // after createdAt
        ]),
      },
      userRepo: { getLocale: getLocaleUTC() },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].matchedRefs).toEqual(['post']); // 'pre' excluded
  });

  it('isolates a failing watch so the rest still run', async () => {
    const claimDue = vi.fn().mockResolvedValue(true);
    // First getLocale throws → the 'bad' watch fails before its claim; 'good' proceeds.
    const getLocale = vi
      .fn()
      .mockRejectedValueOnce(new Error('locale lookup failed'))
      .mockResolvedValue({ language: null, timezone: 'UTC' });
    await runWatchSchedulerJob({
      now: NOW,
      watchRepo: { listDue: vi.fn().mockResolvedValue([watch({ id: 'bad' }), watch({ id: 'good' })]), claimDue },
      runRepo: { create: vi.fn().mockResolvedValue({}) },
      signalRepo: { getRecent: getRecentWith([signal({ id: 'a' })]) },
      userRepo: { getLocale },
    });
    expect(claimDue).toHaveBeenCalledTimes(1); // only the good one reached the claim
    expect(claimDue.mock.calls[0]![0]).toBe('good');
  });
});
