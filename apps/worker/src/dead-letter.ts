import { createLogger } from '@skytwin/core';
import {
  workerDeadLetterRepository,
  type WorkerDeadLetterErrorCode,
  type WorkerDeadLetterJobCode,
} from '@skytwin/db';
import { classifyWorkerFailure } from './content-free-error.js';

const log = createLogger('worker:dead-letter');

/**
 * Dead-letter wrapper for the worker's global background jobs (#407).
 *
 * The worker loop runs each global job (domain extraction, embedding
 * backfill, briefing generation, federation sync, …) on a cadence and
 * historically did `await runX().catch(log.warn)` — a job that fails on
 * EVERY tick logged a warning forever with no retry budget and no
 * operator visibility.
 *
 * `DeadLetterTracker` adds a per-job consecutive-failure counter. When a
 * job's failure streak reaches `maxRetries`, the tracker writes one row
 * to `worker_dead_letter` capturing a stable error code + attempt count, then
 * resets the streak so the table isn't spammed with a row per tick. A
 * subsequent success clears the streak — a job that recovers on its own
 * never reaches the DLQ.
 *
 * The wrapper NEVER throws: a failure to write the DLQ row is logged and
 * swallowed, exactly like the prior `.catch()` behaviour. Worker
 * resilience is the invariant — the DLQ is observability layered on top,
 * not a new failure mode in the poll loop.
 */
export interface DeadLetterTrackerOptions {
  /**
   * Consecutive failures before a job is dead-lettered. Default 3 —
   * matches the per-user circuit breaker's `failureThreshold` so a job
   * gets the same "three strikes" budget as a flaky connector.
   */
  maxRetries?: number;
  /**
   * Sink for recording a dead-lettered job. Injectable so tests don't
   * touch the DB. Defaults to the real repository.
   */
  record?: (input: {
    jobName: WorkerDeadLetterJobCode;
    errorCode: WorkerDeadLetterErrorCode;
    attempts: number;
  }) => Promise<unknown>;
}

/** Map an arbitrary failure to a bounded, content-free operational code. */
export function classifyDeadLetterError(error: unknown): WorkerDeadLetterErrorCode {
  return classifyWorkerFailure(error);
}

/**
 * Log a scheduled-job failure without forwarding throwable text. Keeping this
 * next to the classifier gives every fire-and-forget DLQ callsite one bounded
 * logging path rather than five chances to reintroduce raw user/source text.
 */
export function logDeadLetterJobFailure(
  jobName: WorkerDeadLetterJobCode,
  error: unknown,
): void {
  log.warn('Scheduled job failed', {
    jobName,
    errorCode: classifyDeadLetterError(error),
  });
}

/** Log DLQ-retention failures without forwarding database error text. */
export function logDeadLetterPurgeFailure(error: unknown): void {
  log.warn('worker_dead_letter purge failed — continuing', {
    errorCode: classifyDeadLetterError(error),
  });
}

export class DeadLetterTracker {
  private readonly maxRetries: number;
  private readonly record: NonNullable<DeadLetterTrackerOptions['record']>;
  /** Per-job consecutive-failure streak. */
  private readonly failureStreaks = new Map<WorkerDeadLetterJobCode, number>();

  constructor(opts: DeadLetterTrackerOptions = {}) {
    this.maxRetries = Math.max(1, opts.maxRetries ?? 3);
    this.record =
      opts.record ??
      ((input) => workerDeadLetterRepository.record(input));
  }

  /**
   * Run `fn` (one execution of a job). On success, clears the job's
   * failure streak and returns the result. On failure, increments the
   * streak, logs, and — once the streak reaches `maxRetries` — writes a
   * dead-letter row and resets the streak.
   *
   * Always resolves (never rejects): mirrors the worker loop's existing
   * "catch and continue" contract. Returns `undefined` on failure so the
   * caller can branch on a defined result if it cares.
   */
  async run<T>(
    jobName: WorkerDeadLetterJobCode,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      const result = await fn();
      // Recovered (or never failing): clear the streak so a future
      // failure starts counting fresh.
      this.failureStreaks.delete(jobName);
      return result;
    } catch (err) {
      const errorCode = classifyDeadLetterError(err);
      const attempts = (this.failureStreaks.get(jobName) ?? 0) + 1;
      this.failureStreaks.set(jobName, attempts);

      if (attempts >= this.maxRetries) {
        log.error(
          'Scheduled job exhausted its retry budget; dead-lettering',
          { jobName, attempts, maxRetries: this.maxRetries, errorCode },
        );
        try {
          await this.record({
            jobName,
            errorCode,
            attempts,
          });
        } catch (recordErr) {
          // DLQ write failed — log and swallow. The worker keeps running;
          // we simply lose the operator-visible record this once.
          log.error('Failed to write dead-letter row — continuing', {
            jobName,
            errorCode: classifyDeadLetterError(recordErr),
          });
        }
        // Reset so we don't write a row every tick once over threshold.
        this.failureStreaks.delete(jobName);
      } else {
        log.warn(
          'Scheduled job failed and will retry next cycle',
          { jobName, attempts, maxRetries: this.maxRetries, errorCode },
        );
      }
      return undefined;
    }
  }

  /**
   * Record a job outcome when success/failure is observed OUTSIDE `run()`
   * — i.e. the fire-and-forget jobs whose success lands in `.then()` and
   * failure in `.catch()` (relationship-tier backfill, briefing generator,
   * promotion-eligibility). Pass the caught error to count a failure, or
   * `null`/`undefined` to clear the streak on success.
   *
   * Like `run()`, this never throws: a DLQ write failure is logged and
   * swallowed.
   */
  async recordOutcome(jobName: WorkerDeadLetterJobCode, error: unknown): Promise<void> {
    if (error === null || error === undefined) {
      this.failureStreaks.delete(jobName);
      return;
    }
    const errorCode = classifyDeadLetterError(error);
    const attempts = (this.failureStreaks.get(jobName) ?? 0) + 1;
    this.failureStreaks.set(jobName, attempts);

    if (attempts >= this.maxRetries) {
      log.error(
        'Scheduled job exhausted its retry budget; dead-lettering',
        { jobName, attempts, maxRetries: this.maxRetries, errorCode },
      );
      try {
        await this.record({ jobName, errorCode, attempts });
      } catch (recordErr) {
        log.error('Failed to write dead-letter row — continuing', {
          jobName,
          errorCode: classifyDeadLetterError(recordErr),
        });
      }
      this.failureStreaks.delete(jobName);
    }
    // Below threshold: streak already incremented; the caller emitted the
    // bounded job/error codes. Stay quiet to avoid double-logging the same
    // failure.
  }

  /** Current consecutive-failure streak for a job (0 if none). Test/diagnostic. */
  getFailureStreak(jobName: WorkerDeadLetterJobCode): number {
    return this.failureStreaks.get(jobName) ?? 0;
  }
}
