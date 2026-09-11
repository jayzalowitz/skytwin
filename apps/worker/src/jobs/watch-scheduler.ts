import { createLogger } from '@skytwin/core';
import {
  watchRunRepository,
  signalRepository,
} from '@skytwin/db';
import type { SignalRow } from '@skytwin/db';
import type { RoutineSpec } from '@skytwin/shared-types';
import { computeNextRun, matchesFilter, type MatchableSignal } from '@skytwin/routines';

const log = createLogger('worker:watch-scheduler');

/** Cap on the matched-signal refs stored in a run row (matchedCount keeps the true total). */
const MAX_STORED_REFS = 200;
const MAX_SLOTS_PER_TICK = 100;
const ZERO_MATCH_RETENTION_DAYS = 30;

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
 * Pure: which of `signals` in the half-open window `(windowStart, windowEnd]`
 * match the watch, and the digest/notify summary. The upper bound is the claim
 * time, and the NEXT run's `windowStart` is this claim time — so a signal at
 * exactly the boundary is counted once, never dropped or double-counted. No DB,
 * no clock — unit-testable in isolation.
 */
export function evaluateWatch(
  watch: RoutineSpec,
  signals: SignalRow[],
  windowStart: Date,
  windowEnd: Date,
): WatchEvaluation {
  const matched = signals.filter(
    (s) =>
      s.timestamp instanceof Date &&
      s.timestamp > windowStart &&
      s.timestamp <= windowEnd &&
      matchesFilter(toMatchable(s), watch.filter),
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
  // matchedCount is the true total; store a bounded slice of refs so a run row
  // can't balloon on a pathological match set.
  return { matchedCount: n, matchedRefs: matched.slice(0, MAX_STORED_REFS).map((s) => s.id), summary };
}

export interface WatchSchedulerDeps {
  runRepo?: Pick<
    typeof watchRunRepository,
    'claimNextDueSlot' | 'completeSlot' | 'failSlot' | 'pruneZeroMatchSlots'
  >;
  signalRepo?: Pick<typeof signalRepository, 'listInWindow'>;
}

/**
 * Claim durable scheduled slots, evaluate their persisted windows, and finish
 * each slot even when no signal matched. Read-only processing is lease-retried;
 * user-facing repositories hide zero-match slots. Each slot is isolated so one
 * failure cannot stall the rest.
 */
export async function runWatchSchedulerJob(deps: WatchSchedulerDeps = {}): Promise<void> {
  const runRepo = deps.runRepo ?? watchRunRepository;
  const signalRepo = deps.signalRepo ?? signalRepository;
  let completed = 0;
  let matched = 0;
  for (let i = 0; i < MAX_SLOTS_PER_TICK; i += 1) {
    const slot = await runRepo.claimNextDueSlot({ calculateNextRun: computeNextRun });
    if (!slot) break;
    try {
      const signals = await signalRepo.listInWindow(slot.userId, slot.windowStart, slot.windowEnd);
      const evalResult = evaluateWatch(slot.spec, signals, slot.windowStart, slot.windowEnd);
      const wonLease = await runRepo.completeSlot({
        id: slot.id,
        leaseToken: slot.leaseToken,
        matchedCount: evalResult.matchedCount,
        summary: evalResult.summary,
        matchedRefs: evalResult.matchedRefs,
      });
      if (wonLease) {
        completed += 1;
        if (evalResult.matchedCount > 0) matched += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const result = await runRepo.failSlot({
          id: slot.id,
          leaseToken: slot.leaseToken,
          retryDelayMs: WATCH_SCHEDULER_INTERVAL_MS,
          error: message,
        });
        log.error(`Watch slot ${slot.id} failed (${result})`, { error: message });
      } catch (failError) {
        log.error(`Watch slot ${slot.id} failed and could not record the failure`, {
          error: failError instanceof Error ? failError.message : String(failError),
          processingError: message,
        });
      }
    }
  }

  if (completed > 0) {
    log.info(`Watch scheduler: completed ${completed} durable slot(s); ${matched} produced matches`);
  }
  try {
    await runRepo.pruneZeroMatchSlots(ZERO_MATCH_RETENTION_DAYS, 100);
  } catch (err) {
    log.error('Watch scheduler could not prune expired zero-match slots', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
