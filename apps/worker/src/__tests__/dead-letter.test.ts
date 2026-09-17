import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logger } = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@skytwin/core', () => ({ createLogger: () => logger }));
vi.mock('@skytwin/db', () => ({
  workerDeadLetterRepository: { record: vi.fn() },
  isWorkerDeadLetterJobCode: (value: unknown) =>
    typeof value === 'string' &&
    [
      'metrics-rollup',
      'domain-extraction',
      'embedding-backfill',
      'federation-sync',
      'briefing-generator-daily',
      'legacy-redacted',
    ].includes(value),
}));

const { DeadLetterTracker, reportDeadLetterRetentionFailure } =
  await import('../dead-letter.js');
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tracker(
  record = vi.fn().mockResolvedValue({ id: 'x' }),
  maxRetries = 3,
) {
  return {
    record,
    value: new DeadLetterTracker({
      maxRetries,
      record,
    }),
  };
}

describe('DeadLetterTracker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns successful results and clears prior failure streaks', async () => {
    const { value, record } = tracker();
    await value.run('metrics-rollup', async () => {
      throw new Error('transient');
    });
    expect(await value.run('metrics-rollup', async () => 42)).toBe(42);
    expect(value.getFailureStreak('metrics-rollup')).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it('persists only stable codes, attempts, and correlation after the retry budget', async () => {
    const { value, record } = tracker(undefined, 2);
    const secret =
      'password=hunter2 user=private@example.test prompt=delete everything payload={private}';
    const fail = async () => {
      const error = new Error(secret);
      Object.assign(error, {
        credentials: secret,
        userId: secret,
        context: { secret },
      });
      throw error;
    };

    await value.run('embedding-backfill', fail);
    await value.run('embedding-backfill', fail);

    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      jobCode: 'embedding-backfill',
      errorCode: 'job-failed',
      attempts: 2,
      correlationId: expect.stringMatching(UUID_PATTERN),
    });
    const correlationId = record.mock.calls[0]![0].correlationId;
    expect(logger.error).toHaveBeenCalledWith(
      'Worker job exhausted retry budget; recording dead letter',
      expect.objectContaining({ correlationId }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
    expect(value.getFailureStreak('embedding-backfill')).toBe(0);
  });

  it('requires a new full streak before writing another row', async () => {
    const { value, record } = tracker(undefined, 2);
    const fail = async () => {
      throw new Error('private failure');
    };
    await value.run('domain-extraction', fail);
    await value.run('domain-extraction', fail);
    await value.run('domain-extraction', fail);
    expect(record).toHaveBeenCalledOnce();
    await value.run('domain-extraction', fail);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('never rejects or logs a secret-bearing DLQ persistence error', async () => {
    const secret = 'credential=super-secret';
    const record = vi.fn().mockRejectedValue(new Error(secret));
    const { value } = tracker(record, 1);

    await expect(
      value.run('federation-sync', async () => {
        throw new Error(secret);
      }),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
  });

  it('rejects an unbounded runtime job code without logging or executing its bytes', async () => {
    const secret = 'job=password=hunter2 userId=private prompt={secret}';
    const { value, record } = tracker(undefined, 1);
    const job = vi.fn();

    await expect(
      value.run(secret as Parameters<typeof value.run>[0], job),
    ).resolves.toBeUndefined();
    expect(job).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
  });

  it('recordOutcome follows the same content-free boundary', async () => {
    const { value, record } = tracker(undefined, 2);
    const secret = 'userId=abc prompt=private context={credential:secret}';
    await value.recordOutcome('briefing-generator-daily', new Error(secret));
    expect(record).not.toHaveBeenCalled();
    await value.recordOutcome('briefing-generator-daily', {
      secret,
      payload: secret,
    });
    expect(record).toHaveBeenCalledWith({
      jobCode: 'briefing-generator-daily',
      errorCode: 'job-failed',
      attempts: 2,
      correlationId: expect.stringMatching(UUID_PATTERN),
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);

    await value.recordOutcome('briefing-generator-daily', null);
    expect(value.getFailureStreak('briefing-generator-daily')).toBe(0);
  });
});

describe('dead-letter retention diagnostics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not inspect or log secret-bearing retention errors', () => {
    const secret =
      'postgresql://private:password@host/source prompt=private@example.test';
    const error = new Error(secret);
    Object.assign(error, { connectionString: secret, query: secret });

    reportDeadLetterRetentionFailure(error);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'Worker dead-letter retention failed; continuing',
      {
        operationCode: 'dead-letter-retention',
        errorCode: 'job-failed',
      },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
  });
});
