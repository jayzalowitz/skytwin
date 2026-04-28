import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { forwardedSignalsRepository } = await import(
  '../repositories/forwarded-signals-repository.js'
);

describe('forwardedSignalsRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mark() upserts idempotently on (user_id, signal_key)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await forwardedSignalsRepository.mark('user-1', 'gmail:sig_abc');

    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('ON CONFLICT (user_id, signal_key) DO NOTHING');
    expect(args).toEqual(['user-1', 'gmail:sig_abc']);
  });

  it('markBatch() inserts multiple rows in one query', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 2 });

    await forwardedSignalsRepository.markBatch([
      { userId: 'user-1', signalKey: 'gmail:sig_a' },
      { userId: 'user-2', signalKey: 'gmail:sig_b' },
    ]);

    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('VALUES ($1, $2), ($3, $4)');
    expect(args).toEqual(['user-1', 'gmail:sig_a', 'user-2', 'gmail:sig_b']);
  });

  it('markBatch() with empty input is a no-op', async () => {
    await forwardedSignalsRepository.markBatch([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('listSince() filters by an INTERVAL derived from the TTL', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await forwardedSignalsRepository.listSince(24 * 60 * 60 * 1000);

    const [, args] = mockQuery.mock.calls[0]!;
    expect(args).toEqual(['86400 seconds']);
  });

  it('gcOlderThan() returns the rowCount of removed rows', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 17 });

    const removed = await forwardedSignalsRepository.gcOlderThan(60_000);

    expect(removed).toBe(17);
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('DELETE FROM forwarded_signals');
    expect(args).toEqual(['60 seconds']);
  });

  it('gcOlderThan() with no matches returns 0', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: null });
    const removed = await forwardedSignalsRepository.gcOlderThan(1000);
    expect(removed).toBe(0);
  });
});
