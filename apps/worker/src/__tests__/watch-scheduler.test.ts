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

  it('matches signals after the window that satisfy the filter', () => {
    const signals = [
      signal({ id: 'a' }), // matches (gmail, from finance@acme.com)
      signal({ id: 'b', data: { from: 'stranger@x.com', subject: 'hi' } }), // wrong sender
      signal({ id: 'c', source: 'voice' }), // wrong source
    ];
    const r = evaluateWatch(watch(), signals, windowStart);
    expect(r.matchedCount).toBe(1);
    expect(r.matchedRefs).toEqual(['a']);
    expect(r.summary).toMatch(/1 update: Q3 budget/);
  });

  it('excludes signals at or before the window start', () => {
    const old = signal({ id: 'old', timestamp: new Date('2026-07-04T00:00:00Z') });
    expect(evaluateWatch(watch(), [old], windowStart).matchedCount).toBe(0);
  });

  it('a notify watch summarizes tersely', () => {
    const r = evaluateWatch(watch({ action: 'notify' }), [signal({ id: 'a' })], windowStart);
    expect(r.summary).toMatch(/New match: Q3 budget/);
  });

  it('no matches → count 0, empty summary', () => {
    const r = evaluateWatch(watch(), [signal({ data: { from: 'nobody@x.com' } })], windowStart);
    expect(r.matchedCount).toBe(0);
    expect(r.summary).toBe('');
  });
});

describe('runWatchSchedulerJob', () => {
  const NOW = new Date('2026-07-05T09:00:00Z');
  const getRecentWith = (rows: SignalRow[]) => vi.fn().mockResolvedValue(rows);
  const getLocaleUTC = () => vi.fn().mockResolvedValue({ language: null, timezone: 'UTC' });

  it('writes a run and schedules the next firing when a due watch matches', async () => {
    const listDue = vi.fn().mockResolvedValue([watch()]);
    const markRan = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({});
    await runWatchSchedulerJob({
      now: NOW,
      watchRepo: { listDue, markRan },
      runRepo: { create },
      signalRepo: { getRecent: getRecentWith([signal({ id: 'a' })]) },
      userRepo: { getLocale: getLocaleUTC() },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].matchedRefs).toEqual(['a']);
    const nextArg = markRan.mock.calls[0]![2] as Date;
    expect(nextArg.getTime()).toBeGreaterThan(NOW.getTime()); // next_run_at advanced
  });

  it('advances the schedule even when nothing matched (no run row)', async () => {
    const markRan = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({});
    await runWatchSchedulerJob({
      now: NOW,
      watchRepo: { listDue: vi.fn().mockResolvedValue([watch()]), markRan },
      runRepo: { create },
      signalRepo: { getRecent: getRecentWith([]) }, // no signals
      userRepo: { getLocale: getLocaleUTC() },
    });
    expect(create).not.toHaveBeenCalled();
    expect(markRan).toHaveBeenCalledTimes(1); // still rescheduled
  });

  it('isolates a failing watch so the rest still run', async () => {
    const markRan = vi.fn().mockResolvedValue(undefined);
    // First getLocale throws → the 'bad' watch fails; the 'good' one proceeds.
    const getLocale = vi
      .fn()
      .mockRejectedValueOnce(new Error('locale lookup failed'))
      .mockResolvedValue({ language: null, timezone: 'UTC' });
    await runWatchSchedulerJob({
      now: NOW,
      watchRepo: { listDue: vi.fn().mockResolvedValue([watch({ id: 'bad' }), watch({ id: 'good' })]), markRan },
      runRepo: { create: vi.fn().mockResolvedValue({}) },
      signalRepo: { getRecent: getRecentWith([signal({ id: 'a' })]) },
      userRepo: { getLocale },
    });
    expect(markRan).toHaveBeenCalledTimes(1); // only the good one
    expect(markRan.mock.calls[0]![0]).toBe('good');
  });
});
