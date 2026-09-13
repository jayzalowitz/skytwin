import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClientQuery, mockQuery, mockWithTransaction } = vi.hoisted(() => ({
  mockClientQuery: vi.fn(),
  mockQuery: vi.fn(),
  mockWithTransaction: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  query: mockQuery,
  withTransaction: mockWithTransaction,
}));

import { completeEmbeddingJob, leaseEmbeddingJob, markJobFailed } from '../repository.js';

describe('leaseEmbeddingJob SQL', () => {
  beforeEach(() => {
    mockClientQuery.mockReset();
    mockQuery.mockReset();
    mockWithTransaction.mockReset();
    mockWithTransaction.mockImplementation(
      async (operation: (client: { query: typeof mockClientQuery }) => Promise<unknown>) =>
        operation({ query: mockClientQuery }),
    );
  });

  it('makes an expired in-progress lease available for a new claim', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', user_id: 'user-1', page_id: 'page-1' }],
      })
      .mockResolvedValueOnce({ rows: [{ lease_token: '2026-01-01 00:05:00+00:00' }] })
      .mockResolvedValueOnce({ rows: [{ title: 'Title', content: 'Body' }] });

    await expect(leaseEmbeddingJob()).resolves.toMatchObject({
      id: 'job-1',
      leaseToken: '2026-01-01 00:05:00+00:00',
    });

    const [terminalizeSql] = mockClientQuery.mock.calls[0] as [string];
    expect(terminalizeSql).toContain('attempts >= 3');
    expect(terminalizeSql).toContain("status = 'failed'");

    const [claimSql] = mockClientQuery.mock.calls[1] as [string];
    expect(claimSql).toContain('attempts < 3');
    expect(claimSql).toContain(
      "status = 'pending' AND (leased_until IS NULL OR leased_until < now())",
    );
    expect(claimSql).toContain("status = 'in_progress' AND leased_until < now()");
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('updates the page and completes the job in one exact-lease transaction', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ page_id: 'page-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'job-1' }] });

    await expect(completeEmbeddingJob(
      'job-1',
      '2026-01-01 00:05:00+00:00',
      [0.25, 0.75],
      'test-model',
    )).resolves.toBe(true);

    const [lockSql, lockParams] = mockClientQuery.mock.calls[0] as [string, unknown[]];
    expect(lockSql).toContain("status = 'in_progress'");
    expect(lockSql).toContain('leased_until = $2::TIMESTAMPTZ');
    expect(lockSql).toContain('leased_until > now()');
    expect(lockSql).toContain('FOR UPDATE');
    expect(lockParams).toEqual(['job-1', '2026-01-01 00:05:00+00:00']);
    expect(mockClientQuery.mock.calls[1]?.[0]).toContain('UPDATE brain_pages');
    expect(mockClientQuery.mock.calls[2]?.[0]).toContain("SET status = 'completed'");
  });

  it('does not write a page when the exact lease is no longer active', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    await expect(completeEmbeddingJob(
      'job-1',
      'stale-lease',
      [0.9, 0.1],
      'stale-model',
    )).resolves.toBe(false);
    expect(mockClientQuery).toHaveBeenCalledOnce();
  });

  it('throws to roll back the page write if locked completion cannot terminalize the job', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ page_id: 'page-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(completeEmbeddingJob(
      'job-1',
      '2026-01-01 00:05:00+00:00',
      [0.25, 0.75],
      'test-model',
    )).rejects.toThrow('Embedding job lease changed while completion was locked');
  });

  it('conditions failure on the same exact active lease', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(markJobFailed('job-1', 'lease-token', 'provider failed')).resolves.toBe(false);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('leased_until = $2::TIMESTAMPTZ');
    expect(sql).toContain('leased_until > now()');
    expect(params).toEqual(['job-1', 'lease-token', 'provider failed']);
  });
});
