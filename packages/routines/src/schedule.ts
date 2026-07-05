import type { RoutineSpec } from '@skytwin/shared-types';

/**
 * Compute a Watch's next firing time (#519). Pure + deterministic given
 * `(spec, from, tz)`, so the worker scheduler can be unit-tested without a clock.
 *
 * `hourOfDay` / `dayOfWeek` are USER-LOCAL, so the daily/weekly math is done in
 * the user's IANA timezone (default `UTC`) using only native `Intl` — no date
 * library. The wall-clock↔UTC conversion is the standard guess-and-correct: it
 * is exact except within the ~1h DST transition window, where a run may fire up
 * to an hour off twice a year (acceptable for a digest cadence).
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * Return `tz` if it's a valid IANA zone, else `UTC`. `Intl.DateTimeFormat`
 * throws `RangeError` on an unknown zone, and the tz comes from user data
 * (synced from a calendar, possibly stale/malformed) — a bad value must degrade
 * to UTC, never crash the scheduler tick.
 */
function safeTz(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/**
 * Offset (ms) such that `instant + offset`, read as a UTC wall-clock, equals the
 * local wall-clock in `tz`. I.e. `localAsUTC - actualUTC`.
 */
function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUTC = Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!);
  return asUTC - instant.getTime();
}

/** Convert a wall-clock time in `tz` to the corresponding UTC instant. */
function zonedWallClockToUtc(y: number, mo: number, d: number, h: number, min: number, tz: string): Date {
  const guessUtc = Date.UTC(y, mo, d, h, min);
  // Guess-and-correct with a SECOND pass: across a DST boundary the tz offset at
  // the corrected instant differs from the offset at the guess, so one iteration
  // is off by the DST delta for some target hours. Re-reading the offset at the
  // candidate converges to the correct instant. (A wall-clock time inside the
  // spring-forward gap has no exact answer; it lands adjacent to the gap.)
  const off1 = tzOffsetMs(new Date(guessUtc), tz);
  const off2 = tzOffsetMs(new Date(guessUtc - off1), tz);
  return new Date(guessUtc - off2);
}

/** The local calendar date + day-of-week (0=Sun) in `tz` for an instant. */
function zonedParts(instant: Date, tz: string): { y: number; mo: number; d: number; dow: number } {
  const local = new Date(instant.getTime() + tzOffsetMs(instant, tz));
  return {
    y: local.getUTCFullYear(),
    mo: local.getUTCMonth(),
    d: local.getUTCDate(),
    dow: local.getUTCDay(),
  };
}

export function computeNextRun(spec: RoutineSpec, from: Date, tzInput = 'UTC'): Date {
  // Total on a bad clock: fail loud (caught per-watch by the scheduler) rather
  // than silently returning an Invalid Date or throwing a cryptic RangeError
  // from deep inside the tz math.
  if (Number.isNaN(from.getTime())) {
    throw new TypeError('computeNextRun: `from` must be a valid Date');
  }
  if (spec.cadence === 'hourly') {
    return new Date(from.getTime() + HOUR_MS);
  }

  const tz = safeTz(tzInput);
  const hour = spec.hourOfDay ?? 8;
  const { y, mo, d } = zonedParts(from, tz);

  if (spec.cadence === 'daily') {
    let candidate = zonedWallClockToUtc(y, mo, d, hour, 0, tz);
    if (candidate.getTime() <= from.getTime()) {
      candidate = zonedWallClockToUtc(y, mo, d + 1, hour, 0, tz); // Date.UTC normalizes overflow
    }
    return candidate;
  }

  // weekly: the next instant that is `dayOfWeek` at `hour` local time, strictly
  // after `from`. Walk forward a full week; exactly one day matches the target
  // dow, and if that's today-but-past we roll to next week (i === 7).
  // Normalize dayOfWeek into 0-6 (the API validates it, but this exported pure
  // function must stay total for a direct/corrupt caller).
  const rawDow = spec.dayOfWeek ?? zonedParts(from, tz).dow;
  const targetDow = ((Math.trunc(rawDow) % 7) + 7) % 7;
  for (let i = 0; i <= 7; i++) {
    const c = zonedWallClockToUtc(y, mo, d + i, hour, 0, tz);
    if (zonedParts(c, tz).dow === targetDow && c.getTime() > from.getTime()) return c;
  }
  // Unreachable in practice; keep the type total.
  return zonedWallClockToUtc(y, mo, d + 7, hour, 0, tz);
}
