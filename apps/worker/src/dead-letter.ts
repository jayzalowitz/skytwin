import { createLogger } from '@skytwin/core';
import { workerDeadLetterRepository } from '@skytwin/db';

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
 * to `worker_dead_letter` capturing the final error + attempt count, then
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
    jobName: string;
    errorMessage: string;
    attempts: number;
    context?: unknown;
  }) => Promise<unknown>;
}

export class DeadLetterTracker {
  private readonly maxRetries: number;
  private readonly record: NonNullable<DeadLetterTrackerOptions['record']>;
  /** Per-job consecutive-failure streak. */
  private readonly failureStreaks = new Map<string, number>();

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
    jobName: string,
    fn: () => Promise<T>,
    context?: unknown,
  ): Promise<T | undefined> {
    try {
      const result = await fn();
      // Recovered (or never failing): clear the streak so a future
      // failure starts counting fresh.
      this.failureStreaks.delete(jobName);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = (this.failureStreaks.get(jobName) ?? 0) + 1;
      this.failureStreaks.set(jobName, attempts);

      if (attempts >= this.maxRetries) {
        log.error(
          `Job "${jobName}" failed ${attempts}x consecutively — dead-lettering`,
          { error: message },
        );
        try {
          await this.record({
            jobName,
            errorMessage: message,
            attempts,
            context,
          });
        } catch (recordErr) {
          // DLQ write failed — log and swallow. The worker keeps running;
          // we simply lose the operator-visible record this once.
          log.error('Failed to write dead-letter row — continuing', {
            jobName,
            error:
              recordErr instanceof Error
                ? recordErr.message
                : String(recordErr),
          });
        }
        // Reset so we don't write a row every tick once over threshold.
        this.failureStreaks.delete(jobName);
      } else {
        log.warn(
          `Job "${jobName}" failed (${attempts}/${this.maxRetries}) — will retry next cycle`,
          { error: message },
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
  async recordOutcome(jobName: string, error: unknown, context?: unknown): Promise<void> {
    if (error === null || error === undefined) {
      this.failureStreaks.delete(jobName);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const attempts = (this.failureStreaks.get(jobName) ?? 0) + 1;
    this.failureStreaks.set(jobName, attempts);

    if (attempts >= this.maxRetries) {
      log.error(
        `Job "${jobName}" failed ${attempts}x consecutively — dead-lettering`,
        { error: message },
      );
      try {
        await this.record({ jobName, errorMessage: message, attempts, context });
      } catch (recordErr) {
        log.error('Failed to write dead-letter row — continuing', {
          jobName,
          error:
            recordErr instanceof Error ? recordErr.message : String(recordErr),
        });
      }
      this.failureStreaks.delete(jobName);
    }
    // Below threshold: streak already incremented; the caller logged its
    // own warn (it has job-specific context). Stay quiet to avoid double-
    // logging the same failure.
  }

  /** Current consecutive-failure streak for a job (0 if none). Test/diagnostic. */
  getFailureStreak(jobName: string): number {
    return this.failureStreaks.get(jobName) ?? 0;
  }
}
