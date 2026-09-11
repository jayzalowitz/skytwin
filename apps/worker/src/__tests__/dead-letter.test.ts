import { beforeEach, describe, it, expect, vi } from 'vitest';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// Mock the workspace deps so the tracker can be unit-tested in isolation
// without the full pnpm workspace resolution. The tests always inject
// `record`, so the real repository is never exercised here.
vi.mock('@skytwin/core', () => ({
  createLogger: () => mockLog,
}));
vi.mock('@skytwin/db', () => ({
  workerDeadLetterRepository: { record: vi.fn() },
}));

const {
  DeadLetterTracker,
  classifyDeadLetterError,
  logDeadLetterJobFailure,
  logDeadLetterPurgeFailure,
} = await import('../dead-letter.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('classifyDeadLetterError', () => {
  it('maps known operational failures without retaining their messages', () => {
    expect(classifyDeadLetterError(Object.assign(new Error('contains private SQL'), { code: '08006' })))
      .toBe('database_unavailable');
    expect(classifyDeadLetterError(Object.assign(new Error('private URL'), { code: 'ECONNREFUSED' })))
      .toBe('network_unavailable');
    expect(classifyDeadLetterError({ status: 429, message: 'private provider response' }))
      .toBe('rate_limited');
  });

  it('collapses arbitrary throwables to a content-free fallback', () => {
    expect(classifyDeadLetterError(new Error('customer@example.com secret'))).toBe('job_failed');
    expect(classifyDeadLetterError('raw user text')).toBe('job_failed');
  });
});

describe('content-free failure logging', () => {
  const marker = 'SECRET-user@example.test-private-source';

  it('logs fire-and-forget failures as allowlisted codes only', () => {
    logDeadLetterJobFailure(
      'briefing-generator-daily',
      Object.assign(new Error(marker), { code: 'ECONNREFUSED' }),
    );

    const serializedCalls = JSON.stringify(mockLog.warn.mock.calls);
    expect(serializedCalls).not.toContain(marker);
    expect(mockLog.warn).toHaveBeenCalledWith('Scheduled job failed', {
      jobName: 'briefing-generator-daily',
      errorCode: 'network_unavailable',
    });
  });

  it('never logs the original failure or a rejected DLQ write payload', async () => {
    const record = vi.fn().mockRejectedValue(
      Object.assign(new Error(`write-${marker}`), { code: '08006' }),
    );
    const tracker = new DeadLetterTracker({ maxRetries: 1, record });

    await tracker.run('embedding-backfill', async () => {
      throw new Error(`job-${marker}`);
    });

    const serializedCalls = JSON.stringify([
      ...mockLog.warn.mock.calls,
      ...mockLog.error.mock.calls,
    ]);
    expect(serializedCalls).not.toContain(marker);
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to write dead-letter row — continuing',
      { jobName: 'embedding-backfill', errorCode: 'database_unavailable' },
    );
  });

  it('logs DLQ purge failures without database error text', () => {
    logDeadLetterPurgeFailure(
      Object.assign(new Error(`purge-${marker}`), { code: '08006' }),
    );

    const serializedCalls = JSON.stringify(mockLog.warn.mock.calls);
    expect(serializedCalls).not.toContain(marker);
    expect(mockLog.warn).toHaveBeenCalledWith(
      'worker_dead_letter purge failed — continuing',
      { errorCode: 'database_unavailable' },
    );
  });
});

describe('DeadLetterTracker', () => {
  describe('run', () => {
    it('returns the result and clears the streak on success', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'x' });
      const tracker = new DeadLetterTracker({ maxRetries: 3, record });

      const result = await tracker.run('metrics-rollup', async () => 42);
      expect(result).toBe(42);
      expect(tracker.getFailureStreak('metrics-rollup')).toBe(0);
      expect(record).not.toHaveBeenCalled();
    });

    it('does NOT dead-letter before the retry budget is exhausted', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'x' });
      const tracker = new DeadLetterTracker({ maxRetries: 3, record });
      const fail = async () => {
        throw new Error('boom');
      };

      await tracker.run('changelog-poll', fail);
      await tracker.run('changelog-poll', fail);
      expect(record).not.toHaveBeenCalled();
      expect(tracker.getFailureStreak('changelog-poll')).toBe(2);
    });

    it('dead-letters once the failure streak reaches maxRetries, then resets', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq-1' });
      const tracker = new DeadLetterTracker({ maxRetries: 3, record });
      const fail = async () => {
        throw new Error('CRDB unreachable');
      };

      await tracker.run('domain-extraction', fail);
      await tracker.run('domain-extraction', fail);
      await tracker.run('domain-extraction', fail); // 3rd consecutive failure → dead-letter

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith({
        jobName: 'domain-extraction',
        errorCode: 'job_failed',
        attempts: 3,
      });
      // Streak resets so the DLQ isn't spammed with a row every tick.
      expect(tracker.getFailureStreak('domain-extraction')).toBe(0);
    });

    it('does not spam the DLQ: after dead-lettering it takes another full streak', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 2, record });
      const fail = async () => {
        throw new Error('still broken');
      };

      // First streak of 2 → one DLQ row.
      await tracker.run('capability-inference', fail);
      await tracker.run('capability-inference', fail);
      expect(record).toHaveBeenCalledTimes(1);

      // Next tick starts a fresh streak; one failure is not enough.
      await tracker.run('capability-inference', fail);
      expect(record).toHaveBeenCalledTimes(1);

      // Second failure of the new streak → second DLQ row.
      await tracker.run('capability-inference', fail);
      expect(record).toHaveBeenCalledTimes(2);
    });

    it('a success in the middle of a failure streak resets it', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 3, record });
      const fail = async () => {
        throw new Error('flaky');
      };

      await tracker.run('watch-scheduler', fail);
      await tracker.run('watch-scheduler', fail);
      await tracker.run('watch-scheduler', async () => 'ok'); // recovers
      expect(tracker.getFailureStreak('watch-scheduler')).toBe(0);

      // One more failure should NOT dead-letter (streak restarted at 1).
      await tracker.run('watch-scheduler', fail);
      expect(record).not.toHaveBeenCalled();
      expect(tracker.getFailureStreak('watch-scheduler')).toBe(1);
    });

    it('never rejects even when the DLQ write itself throws', async () => {
      const record = vi.fn().mockRejectedValue(new Error('DLQ write failed'));
      const tracker = new DeadLetterTracker({ maxRetries: 1, record });
      const fail = async () => {
        throw new Error('boom');
      };

      // maxRetries=1 → first failure dead-letters; record() throws but
      // run() must still resolve (undefined), not reject.
      await expect(tracker.run('federation-sync', fail)).resolves.toBeUndefined();
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('does not pass job context or raw errors to the DLQ row', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 1, record });
      await tracker.run(
        'embedding-backfill',
        async () => {
          throw new Error('boom');
        },
      );
      expect(record).toHaveBeenCalledWith(
        { jobName: 'embedding-backfill', errorCode: 'job_failed', attempts: 1 },
      );
    });
  });

  describe('recordOutcome (fire-and-forget jobs)', () => {
    it('clears the streak when passed a null/undefined error (success)', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 3, record });
      await tracker.recordOutcome('relationship-tier-backfill', new Error('x'));
      await tracker.recordOutcome('relationship-tier-backfill', null);
      expect(tracker.getFailureStreak('relationship-tier-backfill')).toBe(0);
    });

    it('dead-letters once consecutive failures reach maxRetries', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 2, record });
      await tracker.recordOutcome('memory-action-loop', new Error('fail 1'));
      expect(record).not.toHaveBeenCalled();
      await tracker.recordOutcome('memory-action-loop', new Error('fail 2'));
      expect(record).toHaveBeenCalledWith({
        jobName: 'memory-action-loop',
        errorCode: 'job_failed',
        attempts: 2,
      });
      expect(tracker.getFailureStreak('memory-action-loop')).toBe(0);
    });

    it('redacts non-Error throwables to the stable fallback code', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 1, record });
      await tracker.recordOutcome('briefing-generator-daily', 'plain string failure');
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'job_failed' }),
      );
    });

    it('never rejects when the DLQ write throws', async () => {
      const record = vi.fn().mockRejectedValue(new Error('write failed'));
      const tracker = new DeadLetterTracker({ maxRetries: 1, record });
      await expect(
        tracker.recordOutcome('promotion-eligibility-check', new Error('boom')),
      ).resolves.toBeUndefined();
    });
  });
});
