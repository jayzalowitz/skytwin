import { randomUUID } from 'node:crypto';
import { createLogger } from '@skytwin/core';
import {
  isWorkerDeadLetterJobCode,
  workerDeadLetterRepository,
  type RecordDeadLetterInput,
  type WorkerDeadLetterErrorCode,
  type WorkerDeadLetterJobCode,
} from '@skytwin/db';

const log = createLogger('worker:dead-letter');

type ActiveJobCode = Exclude<WorkerDeadLetterJobCode, 'legacy-redacted'>;
type ActiveErrorCode = Exclude<WorkerDeadLetterErrorCode, 'legacy-redacted'>;

export interface DeadLetterTrackerOptions {
  maxRetries?: number;
  record?: (input: RecordDeadLetterInput) => Promise<unknown>;
}

/**
 * Retention failures are operationally useful, but database errors are not a
 * safe logging surface: driver messages can contain connection or query
 * details. Keep this diagnostic bounded just like persisted dead letters.
 */
export function reportDeadLetterRetentionFailure(_error: unknown): void {
  log.warn('Worker dead-letter retention failed; continuing', {
    operationCode: 'dead-letter-retention',
    errorCode: 'job-failed',
  });
}

/**
 * The DLQ deliberately does not inspect error messages or payloads. A generic,
 * stable code is sufficient to signal that the named job exhausted its retry
 * budget; the opaque correlation ID ties the worker log to the durable row.
 */
function classifyFailure(_error: unknown): ActiveErrorCode {
  return 'job-failed';
}

function isActiveJobCode(value: unknown): value is ActiveJobCode {
  return isWorkerDeadLetterJobCode(value) && value !== 'legacy-redacted';
}

export class DeadLetterTracker {
  private readonly maxRetries: number;
  private readonly record: NonNullable<DeadLetterTrackerOptions['record']>;
  private readonly failureStreaks = new Map<ActiveJobCode, number>();

  constructor(opts: DeadLetterTrackerOptions = {}) {
    this.maxRetries = Math.max(1, opts.maxRetries ?? 3);
    this.record =
      opts.record ?? ((input) => workerDeadLetterRepository.record(input));
  }

  async run<T>(
    jobCode: ActiveJobCode,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    if (!isActiveJobCode(jobCode)) {
      log.error('Worker job rejected an invalid dead-letter code');
      return undefined;
    }
    try {
      const result = await fn();
      this.failureStreaks.delete(jobCode);
      return result;
    } catch (error) {
      await this.recordFailure(jobCode, error, true);
      return undefined;
    }
  }

  async recordOutcome(jobCode: ActiveJobCode, error: unknown): Promise<void> {
    if (!isActiveJobCode(jobCode)) {
      log.error('Worker outcome rejected an invalid dead-letter code');
      return;
    }
    if (error === null || error === undefined) {
      this.failureStreaks.delete(jobCode);
      return;
    }
    await this.recordFailure(jobCode, error, false);
  }

  private async recordFailure(
    jobCode: ActiveJobCode,
    error: unknown,
    logRetry: boolean,
  ): Promise<void> {
    const errorCode = classifyFailure(error);
    const attempts = (this.failureStreaks.get(jobCode) ?? 0) + 1;
    this.failureStreaks.set(jobCode, attempts);

    if (attempts < this.maxRetries) {
      if (logRetry) {
        log.warn('Worker job failed; retry remains scheduled', {
          jobCode,
          errorCode,
          attempts,
          maxRetries: this.maxRetries,
        });
      }
      return;
    }

    const correlationId = randomUUID();
    log.error('Worker job exhausted retry budget; recording dead letter', {
      jobCode,
      errorCode,
      attempts,
      correlationId,
    });
    try {
      await this.record({ jobCode, errorCode, attempts, correlationId });
    } catch {
      log.error('Worker dead-letter write failed; continuing', {
        jobCode,
        errorCode: 'job-failed',
        correlationId,
      });
    }
    this.failureStreaks.delete(jobCode);
  }

  getFailureStreak(jobCode: ActiveJobCode): number {
    return this.failureStreaks.get(jobCode) ?? 0;
  }
}
