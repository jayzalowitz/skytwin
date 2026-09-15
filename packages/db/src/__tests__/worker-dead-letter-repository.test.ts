import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const {
  WORKER_DEAD_LETTER_ERROR_CODES,
  WORKER_DEAD_LETTER_JOB_CODES,
  workerDeadLetterRepository,
} = await import('../repositories/worker-dead-letter-repository.js');

const CORRELATION_ID = '22222222-2222-4222-8222-222222222222';
const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  correlation_id: CORRELATION_ID,
  job_code: 'embedding-backfill' as const,
  error_code: 'job-failed' as const,
  attempts: 3,
  status: 'pending' as const,
  dead_lettered_at: new Date('2026-06-14T12:00:00Z'),
  resolved_at: null,
};

describe('workerDeadLetterRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('inserts only bounded codes, attempts, and an opaque correlation id', async () => {
    mockQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
    const row = await workerDeadLetterRepository.record({
      jobCode: 'embedding-backfill',
      errorCode: 'job-failed',
      attempts: 3,
      correlationId: CORRELATION_ID,
    });
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain(
      'INSERT INTO worker_dead_letter (job_code, error_code, attempts, correlation_id)',
    );
    expect(sql).not.toMatch(/error_message|context|job_name/i);
    expect(args).toEqual([
      'embedding-backfill',
      'job-failed',
      3,
      CORRELATION_ID,
    ]);
    expect(row).toEqual(ROW);
  });

  it('rejects source-bearing legacy fields before any SQL call', async () => {
    const secret = 'password=hunter2 user=private@example.test prompt=private';
    const malicious = {
      jobCode: 'embedding-backfill',
      errorCode: 'job-failed',
      attempts: 3,
      correlationId: CORRELATION_ID,
      errorMessage: secret,
      context: { userId: secret, payload: secret },
    };

    await expect(
      workerDeadLetterRepository.record(
        malicious as unknown as Parameters<
          typeof workerDeadLetterRepository.record
        >[0],
      ),
    ).rejects.toThrow('Invalid content-free worker dead-letter record');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(JSON.stringify(mockQuery.mock.calls)).not.toContain(secret);
  });

  it.each([
    { jobCode: 'custom secret job' },
    { errorCode: 'database said private@example.test' },
    { attempts: 0 },
    { correlationId: 'not-an-opaque-uuid' },
  ])('rejects malformed content-free records: %o', async (override) => {
    await expect(
      workerDeadLetterRepository.record({
        jobCode: 'metrics-rollup',
        errorCode: 'job-failed',
        attempts: 1,
        correlationId: CORRELATION_ID,
        ...override,
      } as Parameters<typeof workerDeadLetterRepository.record>[0]),
    ).rejects.toThrow('Invalid content-free worker dead-letter record');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('lists pending rows and filters by stable job code', async () => {
    mockQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
    await workerDeadLetterRepository.list({ jobCode: 'embedding-backfill' });
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('job_code = $2');
    expect(sql).not.toMatch(/error_message|context|job_name/i);
    expect(sql).toContain('ORDER BY dead_lettered_at DESC');
    expect(args).toEqual(['pending', 'embedding-backfill', 100]);
  });

  it('supports all-status history and retains the page-size bounds', async () => {
    await workerDeadLetterRepository.list({ status: null, limit: 100_000 });
    let [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).not.toContain('status =');
    expect(args).toEqual([500]);

    await workerDeadLetterRepository.list({ limit: 0 });
    [sql, args] = mockQuery.mock.calls[1]!;
    expect(args.at(-1)).toBe(1);
  });

  it('finds and race-safely resolves rows without selecting retired content', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });
    expect(await workerDeadLetterRepository.findById(ROW.id)).toEqual(ROW);
    expect(mockQuery.mock.calls[0]![0]).not.toMatch(
      /error_message|context|job_name/i,
    );

    const resolved = {
      ...ROW,
      status: 'replayed' as const,
      resolved_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [resolved], rowCount: 1 });
    expect(
      await workerDeadLetterRepository.markResolved(ROW.id, 'replayed'),
    ).toEqual(resolved);
    const [sql, args] = mockQuery.mock.calls[1]!;
    expect(sql).toContain("WHERE id = $1 AND status = 'pending'");
    expect(args).toEqual([ROW.id, 'replayed']);
  });

  it('preserves not-found resolution behavior', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await workerDeadLetterRepository.findById(ROW.id)).toBeNull();
    expect(
      await workerDeadLetterRepository.markResolved(ROW.id, 'discarded'),
    ).toBeNull();
  });

  it('counts pending rows and purges only old resolved history', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '4' }], rowCount: 1 });
    expect(await workerDeadLetterRepository.countPending()).toBe(4);

    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 7 });
    expect(
      await workerDeadLetterRepository.purgeResolvedOlderThan(
        30 * 24 * 60 * 60 * 1000,
      ),
    ).toBe(7);
    const [sql, args] = mockQuery.mock.calls[1]!;
    expect(sql).toContain("status IN ('replayed', 'discarded')");
    expect(args).toEqual(['2592000 seconds']);
  });

  it('preserves empty counts and the minimum retention interval', async () => {
    expect(await workerDeadLetterRepository.countPending()).toBe(0);
    await workerDeadLetterRepository.purgeResolvedOlderThan(0);
    expect(mockQuery.mock.calls[1]![1]).toEqual(['1 seconds']);
  });

  it('keeps migration constraints synchronized with repository code sets', () => {
    const sql = readFileSync(
      new URL(
        '../migrations/081-worker-dead-letter-content-free.sql',
        import.meta.url,
      ),
      'utf8',
    );
    for (const code of WORKER_DEAD_LETTER_JOB_CODES)
      expect(sql).toContain(`'${code}'`);
    for (const code of WORKER_DEAD_LETTER_ERROR_CODES)
      expect(sql).toContain(`'${code}'`);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS error_message/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS context/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS job_name/);
  });
});
