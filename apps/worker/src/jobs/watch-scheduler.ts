import { createLogger } from '@skytwin/core';
import {
  watchRepository,
  watchRunRepository,
  signalRepository,
  userRepository,
} from '@skytwin/db';
import type { SignalRow } from '@skytwin/db';
import type { Watch } from '@skytwin/shared-types';
import { computeNextRun, matchesFilter, type MatchableSignal } from '@skytwin/routines';

const log = createLogger('worker:watch-scheduler');

const HOUR_MS = 60 * 60 * 1000;

/**
 * The scheduler polls this often; per-watch cadence is enforced by each watch's
 * `next_run_at`, so a frequent poll just picks up whatever is due. (#519 pt.3b)
 */
export const WATCH_SCHEDULER_INTERVAL_MS = 60 * 1000;

/**
 * Feature flag. Watches never run unless `SKYTWIN_WATCHES_ENABLED=true`. They
 * are READ-ONLY (digest/notify) so nothing is executed, but this stays opt-in
 * so nothing runs autonomously without explicit enablement (mirrors the other
 * worker jobs' opt-in contract).
 */
export function watchSchedulerEnabled(): boolean {
  return process.env['SKYTWIN_WATCHES_ENABLED'] === 'true';
}

/** Pure poll-loop gate — enabled AND at least one interval since the last run. */
export function shouldRunWatchScheduler(input: {
  enabled: boolean;
  nowMs: number;
  lastRunAt: number;
  intervalMs?: number;
}): boolean {
  if (!input.enabled) return false;
  return input.nowMs - input.lastRunAt >= (input.intervalMs ?? WATCH_SCHEDULER_INTERVAL_MS);
}

/** First-run lookback when a watch has never fired, by cadence. */
function defaultLookbackMs(cadence: Watch['cadence']): number {
  if (cadence === 'hourly') return HOUR_MS;
  if (cadence === 'weekly') return 7 * 24 * HOUR_MS;
  return 24 * HOUR_MS;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Reduce a stored signal to the fields a watch filter matches on. */
export function toMatchable(row: SignalRow): MatchableSignal {
  const d = row.data ?? {};
  return {
    source: row.source,
    from: str(d['from']) || str(d['organizer']),
    text: [d['subject'], d['title'], d['snippet'], d['body'], d['text'], d['description']]
      .map(str)
      .filter((x) => x.length > 0)
      .join(' '),
  };
}

function titleOf(row: SignalRow): string {
  const d = row.data ?? {};
  return str(d['subject']) || str(d['title']) || str(d['summary']) || `${row.source} item`;
}

export interface WatchEvaluation {
  matchedCount: number;
  matchedRefs: string[];
  summary: string;
}

/**
 * Pure: which of `signals` (that arrived after `windowStart`) match the watch,
 * and the digest/notify summary. No DB, no clock — unit-testable in isolation.
 */
export function evaluateWatch(watch: Watch, signals: SignalRow[], windowStart: Date): WatchEvaluation {
  const matched = signals.filter(
    (s) => s.timestamp instanceof Date && s.timestamp > windowStart && matchesFilter(toMatchable(s), watch.filter),
  );
  const titles = matched.map(titleOf);
  const n = matched.length;

  let summary = '';
  if (n > 0) {
    if (watch.action === 'notify') {
      summary = n === 1 ? `New match: ${titles[0]}` : `${n} new matches (e.g. ${titles[0]})`;
    } else {
      const shown = titles.slice(0, 5).join('; ');
      summary = `${n} update${n === 1 ? '' : 's'}: ${shown}${n > 5 ? ' …' : ''}`;
    }
  }
  return { matchedCount: n, matchedRefs: matched.map((s) => s.id), summary };
}

export interface WatchSchedulerDeps {
  now?: Date;
  watchRepo?: Pick<typeof watchRepository, 'listDue' | 'markRan'>;
  runRepo?: Pick<typeof watchRunRepository, 'create'>;
  signalRepo?: Pick<typeof signalRepository, 'getRecent'>;
  userRepo?: Pick<typeof userRepository, 'getLocale'>;
}

/**
 * Fire every due watch: match the user's recent signals against its filter,
 * record a `watch_run` when there's something (the canonical, explanation-
 * carrying record), and schedule the next firing. Read-only — no action, no
 * policy gate. Each watch is isolated so one failure can't stall the rest.
 */
export async function runWatchSchedulerJob(deps: WatchSchedulerDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  const watchRepo = deps.watchRepo ?? watchRepository;
  const runRepo = deps.runRepo ?? watchRunRepository;
  const signalRepo = deps.signalRepo ?? signalRepository;
  const userRepo = deps.userRepo ?? userRepository;

  const due = await watchRepo.listDue(now);
  if (due.length === 0) return;

  let fired = 0;
  for (const watch of due) {
    try {
      const tz = (await userRepo.getLocale(watch.userId)).timezone ?? 'UTC';
      const windowStart = watch.lastRunAt ?? new Date(now.getTime() - defaultLookbackMs(watch.cadence));
      const lookbackHours = Math.ceil((now.getTime() - windowStart.getTime()) / HOUR_MS) + 1;
      const signals = await signalRepo.getRecent(watch.userId, undefined, lookbackHours);

      const evalResult = evaluateWatch(watch, signals, windowStart);
      if (evalResult.matchedCount > 0) {
        await runRepo.create({
          watchId: watch.id,
          userId: watch.userId,
          action: watch.action,
          matchedCount: evalResult.matchedCount,
          summary: evalResult.summary,
          matchedRefs: evalResult.matchedRefs,
        });
        fired += 1;
      }
      // Always advance the schedule, even on a no-match firing.
      await watchRepo.markRan(watch.id, now, computeNextRun(watch, now, tz));
    } catch (err) {
      log.error(`Watch ${watch.id} failed to run`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (fired > 0) log.info(`Watch scheduler: ${fired} of ${due.length} due watch(es) produced a run`);
}
