import { describe, it, expect, vi } from 'vitest';

// Mock the workspace deps so the tracker can be unit-tested in isolation
// without the full pnpm workspace resolution. The tests always inject
// `record`, so the real repository is never exercised here.
vi.mock('@skytwin/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('@skytwin/db', () => ({
  workerDeadLetterRepository: { record: vi.fn() },
}));

const { DeadLetterTracker } = await import('../dead-letter.js');

describe('DeadLetterTracker', () => {
  describe('run', () => {
    it('returns the result and clears the streak on success', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'x' });
      const tracker = new DeadLetterTracker({ maxRetries: 3, record });

      const result = await tracker.run('job-a', async () => 42);
      expect(result).toBe(42);
      expect(tracker.getFailureStreak('job-a')).toBe(0);
      expect(record).not.toHaveBeenCalled();
    });

    it('does NOT dead-letter before the retry budget is exhausted', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'x' });
      const tracker = new DeadLetterTracker({ maxRetries: 3, record });
      const fail = async () => {
        throw new Error('boom');
      };

      await tracker.run('job-b', fail);
      await tracker.run('job-b', fail);
      expect(record).not.toHaveBeenCalled();
      expect(tracker.getFailureStreak('job-b')).toBe(2);
    });

    it('dead-letters once the failure streak reaches maxRetries, then resets', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq-1' });
      const tracker = new DeadLetterTracker({ maxRetries: 3, record });
      const fail = async () => {
        throw new Error('CRDB unreachable');
      };

      await tracker.run('job-c', fail);
      await tracker.run('job-c', fail);
      await tracker.run('job-c', fail); // 3rd consecutive failure → dead-letter

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith({
        jobName: 'job-c',
        errorMessage: 'CRDB unreachable',
        attempts: 3,
        context: undefined,
      });
      // Streak resets so the DLQ isn't spammed with a row every tick.
      expect(tracker.getFailureStreak('job-c')).toBe(0);
    });

    it('does not spam the DLQ: after dead-lettering it takes another full streak', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 2, record });
      const fail = async () => {
        throw new Error('still broken');
      };

      // First streak of 2 → one DLQ row.
      await tracker.run('job-d', fail);
      await tracker.run('job-d', fail);
      expect(record).toHaveBeenCalledTimes(1);

      // Next tick starts a fresh streak; one failure is not enough.
      await tracker.run('job-d', fail);
      expect(record).toHaveBeenCalledTimes(1);

      // Second failure of the new streak → second DLQ row.
      await tracker.run('job-d', fail);
      expect(record).toHaveBeenCalledTimes(2);
    });

    it('a success in the middle of a failure streak resets it', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 3, record });
      const fail = async () => {
        throw new Error('flaky');
      };

      await tracker.run('job-e', fail);
      await tracker.run('job-e', fail);
      await tracker.run('job-e', async () => 'ok'); // recovers
      expect(tracker.getFailureStreak('job-e')).toBe(0);

      // One more failure should NOT dead-letter (streak restarted at 1).
      await tracker.run('job-e', fail);
      expect(record).not.toHaveBeenCalled();
      expect(tracker.getFailureStreak('job-e')).toBe(1);
    });

    it('never rejects even when the DLQ write itself throws', async () => {
      const record = vi.fn().mockRejectedValue(new Error('DLQ write failed'));
      const tracker = new DeadLetterTracker({ maxRetries: 1, record });
      const fail = async () => {
        throw new Error('boom');
      };

      // maxRetries=1 → first failure dead-letters; record() throws but
      // run() must still resolve (undefined), not reject.
      await expect(tracker.run('job-f', fail)).resolves.toBeUndefined();
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('passes the job context through to the DLQ row', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 1, record });
      await tracker.run(
        'job-g',
        async () => {
          throw new Error('boom');
        },
        { cadence: 'weekly' },
      );
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ context: { cadence: 'weekly' } }),
      );
    });
  });

  describe('recordOutcome (fire-and-forget jobs)', () => {
    it('clears the streak when passed a null/undefined error (success)', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 3, record });
      await tracker.recordOutcome('job-h', new Error('x'));
      await tracker.recordOutcome('job-h', null);
      expect(tracker.getFailureStreak('job-h')).toBe(0);
    });

    it('dead-letters once consecutive failures reach maxRetries', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 2, record });
      await tracker.recordOutcome('job-i', new Error('fail 1'));
      expect(record).not.toHaveBeenCalled();
      await tracker.recordOutcome('job-i', new Error('fail 2'), { cadence: 'daily' });
      expect(record).toHaveBeenCalledWith({
        jobName: 'job-i',
        errorMessage: 'fail 2',
        attempts: 2,
        context: { cadence: 'daily' },
      });
      expect(tracker.getFailureStreak('job-i')).toBe(0);
    });

    it('stringifies non-Error throwables', async () => {
      const record = vi.fn().mockResolvedValue({ id: 'dlq' });
      const tracker = new DeadLetterTracker({ maxRetries: 1, record });
      await tracker.recordOutcome('job-j', 'plain string failure');
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: 'plain string failure' }),
      );
    });

    it('never rejects when the DLQ write throws', async () => {
      const record = vi.fn().mockRejectedValue(new Error('write failed'));
      const tracker = new DeadLetterTracker({ maxRetries: 1, record });
      await expect(
        tracker.recordOutcome('job-k', new Error('boom')),
      ).resolves.toBeUndefined();
    });
  });
});
