import { describe, it, expect } from 'vitest';
import { computeNextRun } from '../schedule.js';
import type { RoutineSpec } from '@skytwin/shared-types';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function localHour(d: Date, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
}
function localDow(d: Date, tz: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}
function spec(over: Partial<RoutineSpec>): RoutineSpec {
  return { name: 'w', cadence: 'daily', action: 'digest', filter: {}, ...over };
}

describe('computeNextRun', () => {
  it('hourly: exactly one hour after `from`', () => {
    const from = new Date('2026-07-05T09:17:00Z');
    expect(computeNextRun(spec({ cadence: 'hourly' }), from).getTime()).toBe(from.getTime() + HOUR);
  });

  it('daily (UTC): fires at hourOfDay, later today when the hour is still ahead', () => {
    const from = new Date('2026-07-05T06:00:00Z');
    const next = computeNextRun(spec({ cadence: 'daily', hourOfDay: 8 }), from, 'UTC');
    expect(localHour(next, 'UTC')).toBe(8);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(DAY);
  });

  it('daily: rolls to tomorrow once the hour has passed', () => {
    const from = new Date('2026-07-05T10:00:00Z'); // past 8:00
    const next = computeNextRun(spec({ cadence: 'daily', hourOfDay: 8 }), from, 'UTC');
    expect(localHour(next, 'UTC')).toBe(8);
    // tomorrow 08:00Z is 22h after 10:00Z today
    expect(Math.round((next.getTime() - from.getTime()) / HOUR)).toBe(22);
  });

  it('daily defaults to 8am when hourOfDay is unset', () => {
    const next = computeNextRun(spec({ cadence: 'daily' }), new Date('2026-07-05T00:00:00Z'), 'UTC');
    expect(localHour(next, 'UTC')).toBe(8);
  });

  it('daily respects the USER timezone (8am local, not 8am UTC)', () => {
    const from = new Date('2026-07-05T06:00:00Z');
    const next = computeNextRun(spec({ cadence: 'daily', hourOfDay: 8 }), from, 'America/New_York');
    expect(localHour(next, 'America/New_York')).toBe(8); // 8am in New York
    // ...which is NOT 8am UTC (NY is behind UTC).
    expect(localHour(next, 'UTC')).not.toBe(8);
  });

  it('weekly: next occurrence of dayOfWeek at hourOfDay, within a week', () => {
    const from = new Date('2026-07-05T12:00:00Z');
    const next = computeNextRun(spec({ cadence: 'weekly', dayOfWeek: 1, hourOfDay: 9 }), from, 'UTC');
    expect(localDow(next, 'UTC')).toBe(1); // Monday
    expect(localHour(next, 'UTC')).toBe(9);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(7 * DAY);
  });

  it('weekly: when today IS the target day but the hour passed, rolls to next week', () => {
    // Find a `from` that is the target dow with the hour already past.
    const targetDow = 3; // Wednesday
    // 2026-07-08 is a Wednesday; 12:00Z is past 09:00Z.
    const from = new Date('2026-07-08T12:00:00Z');
    expect(localDow(from, 'UTC')).toBe(targetDow); // sanity
    const next = computeNextRun(spec({ cadence: 'weekly', dayOfWeek: targetDow, hourOfDay: 9 }), from, 'UTC');
    expect(localDow(next, 'UTC')).toBe(targetDow);
    expect(localHour(next, 'UTC')).toBe(9);
    // Rolled a full week forward (~6.9 days later, next Wednesday 09:00Z).
    expect(Math.round((next.getTime() - from.getTime()) / DAY)).toBe(7);
  });

  it('is correct across a DST spring-forward day (8am stays 8am local)', () => {
    // US DST 2026 springs forward on 2026-03-08 (02:00→03:00 in New York).
    const from = new Date('2026-03-08T05:00:00Z'); // 00:00 EST, before the jump
    const next = computeNextRun(spec({ cadence: 'daily', hourOfDay: 8 }), from, 'America/New_York');
    expect(localHour(next, 'America/New_York')).toBe(8); // exactly 8am despite the DST shift
  });

  it('is correct across a DST fall-back day', () => {
    // Falls back 2026-11-01 (02:00→01:00 in New York).
    const from = new Date('2026-11-01T04:00:00Z'); // 00:00 EDT, before the fall-back
    const next = computeNextRun(spec({ cadence: 'daily', hourOfDay: 8 }), from, 'America/New_York');
    expect(localHour(next, 'America/New_York')).toBe(8);
  });

  it('throws a clear error on an invalid `from` date (does not return Invalid Date)', () => {
    expect(() => computeNextRun(spec({ cadence: 'daily' }), new Date('nonsense'), 'UTC')).toThrow(
      /valid Date/i,
    );
    expect(() => computeNextRun(spec({ cadence: 'hourly' }), new Date(NaN))).toThrow(/valid Date/i);
  });

  it('normalizes an out-of-range dayOfWeek instead of returning the wrong day', () => {
    const from = new Date('2026-07-05T12:00:00Z');
    // dayOfWeek 8 wraps to 1 (Monday); the result must be a real weekday, not a fallthrough.
    const next = computeNextRun(spec({ cadence: 'weekly', dayOfWeek: 8, hourOfDay: 9 }), from, 'UTC');
    expect(localDow(next, 'UTC')).toBe(1);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  it('falls back to UTC on an invalid timezone instead of throwing', () => {
    const from = new Date('2026-07-05T06:00:00Z');
    let next!: Date;
    expect(() => {
      next = computeNextRun(spec({ cadence: 'daily', hourOfDay: 8 }), from, 'Not/AZone');
    }).not.toThrow();
    expect(localHour(next, 'UTC')).toBe(8); // computed as if UTC
  });

  it('daily runs are ~24h apart in steady state', () => {
    const from = new Date('2026-07-05T08:00:00Z');
    const s = spec({ cadence: 'daily', hourOfDay: 8 });
    const n1 = computeNextRun(s, from, 'UTC');
    const n2 = computeNextRun(s, n1, 'UTC');
    expect(Math.round((n2.getTime() - n1.getTime()) / HOUR)).toBe(24);
  });
});
