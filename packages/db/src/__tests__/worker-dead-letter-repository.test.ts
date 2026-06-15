import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { workerDeadLetterRepository } = await import(
  '../repositories/worker-dead-letter-repository.js'
);

const ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  job_name: 'embedding-backfill',
  error_message: 'CRDB unreachable',
  attempts: 3,
  context: { batchSize: 25 },
  status: 'pending' as const,
  dead_lettered_at: new Date('2026-06-14T12:00:00Z'),
  resolved_at: null,
};

describe('workerDeadLetterRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('record', () => {
    it('inserts job_name + error + attempts and serializes context to JSON', async () => {
      mockQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
      const row = await workerDeadLetterRepository.record({
        jobName: 'embedding-backfill',
        errorMessage: 'CRDB unreachable',
        attempts: 3,
        context: { batchSize: 25 },
      });
      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO worker_dead_letter');
      expect(sql).toContain('RETURNING');
      expect(args).toEqual([
        'embedding-backfill',
        'CRDB unreachable',
        3,
        JSON.stringify({ batchSize: 25 }),
      ]);
      expect(row).toEqual(ROW);
    });

    it('defaults attempts to 1 and context to null when omitted', async () => {
      mockQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
      await workerDeadLetterRepository.record({
        jobName: 'domain-extraction',
        errorMessage: 'LLM timeout',
      });
      const [, args] = mockQuery.mock.calls[0]!;
      expect(args[2]).toBe(1); // attempts default
      expect(args[3]).toBeNull(); // context default
    });

    it('does not double-encode a context that is already an object', async () => {
      mockQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
      await workerDeadLetterRepository.record({
        jobName: 'briefing-generator-daily',
        errorMessage: 'boom',
        context: { cadence: 'daily' },
      });
      const [, args] = mockQuery.mock.calls[0]!;
      // Single JSON.stringify, not nested-quoted.
      expect(args[3]).toBe('{"cadence":"daily"}');
    });
  });

  describe('list', () => {
    it('defaults to pending status, newest first, with a default limit', async () => {
      mockQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
      await workerDeadLetterRepository.list();
      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("status = $1");
      expect(sql).toContain('ORDER BY dead_lettered_at DESC');
      expect(args[0]).toBe('pending');
      expect(args[args.length - 1]).toBe(100); // default limit
    });

    it('omits the status filter when status is null (include resolved history)', async () => {
      await workerDeadLetterRepository.list({ status: null });
      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).not.toContain('status =');
      // Only the limit param remains.
      expect(args).toEqual([100]);
    });

    it('filters by jobName when provided', async () => {
      await workerDeadLetterRepository.list({ jobName: 'embedding-backfill', status: 'pending' });
      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('job_name = $2');
      expect(args).toEqual(['pending', 'embedding-backfill', 100]);
    });

    it('hard-caps the limit at 500', async () => {
      await workerDeadLetterRepository.list({ limit: 100000 });
      const [, args] = mockQuery.mock.calls[0]!;
      expect(args[args.length - 1]).toBe(500);
    });

    it('floors the limit at 1', async () => {
      await workerDeadLetterRepository.list({ limit: 0 });
      const [, args] = mockQuery.mock.calls[0]!;
      expect(args[args.length - 1]).toBe(1);
    });
  });

  describe('findById', () => {
    it('returns the row when present', async () => {
      mockQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
      const row = await workerDeadLetterRepository.findById(ROW.id);
      expect(row).toEqual(ROW);
      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE id = $1');
      expect(args).toEqual([ROW.id]);
    });

    it('returns null when absent', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      expect(await workerDeadLetterRepository.findById('nope')).toBeNull();
    });
  });

  describe('markResolved', () => {
    it('only transitions a pending row (race-safe) and returns the updated row', async () => {
      const resolved = { ...ROW, status: 'replayed' as const, resolved_at: new Date() };
      mockQuery.mockResolvedValue({ rows: [resolved], rowCount: 1 });
      const row = await workerDeadLetterRepository.markResolved(ROW.id, 'replayed');
      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("WHERE id = $1 AND status = 'pending'");
      expect(sql).toContain('resolved_at = now()');
      expect(args).toEqual([ROW.id, 'replayed']);
      expect(row).toEqual(resolved);
    });

    it('returns null when the row was already resolved (no rows updated)', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      expect(await workerDeadLetterRepository.markResolved(ROW.id, 'discarded')).toBeNull();
    });
  });

  describe('countPending', () => {
    it('returns the numeric count', async () => {
      mockQuery.mockResolvedValue({ rows: [{ count: '4' }], rowCount: 1 });
      expect(await workerDeadLetterRepository.countPending()).toBe(4);
      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("status = 'pending'");
    });

    it('returns 0 when no rows', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      expect(await workerDeadLetterRepository.countPending()).toBe(0);
    });
  });

  describe('purgeResolvedOlderThan', () => {
    it('deletes only resolved rows past the TTL and returns the count', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 7 });
      const purged = await workerDeadLetterRepository.purgeResolvedOlderThan(
        30 * 24 * 60 * 60 * 1000,
      );
      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("status IN ('replayed', 'discarded')");
      expect(sql).toContain('resolved_at IS NOT NULL');
      expect(args[0]).toBe('2592000 seconds');
      expect(purged).toBe(7);
    });

    it('never lets the interval go below 1 second', async () => {
      await workerDeadLetterRepository.purgeResolvedOlderThan(0);
      const [, args] = mockQuery.mock.calls[0]!;
      expect(args[0]).toBe('1 seconds');
    });
  });
});
