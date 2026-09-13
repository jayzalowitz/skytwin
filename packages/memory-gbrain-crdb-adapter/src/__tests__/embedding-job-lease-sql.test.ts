import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClientQuery, mockWithTransaction } = vi.hoisted(() => ({
  mockClientQuery: vi.fn(),
  mockWithTransaction: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  query: vi.fn(),
  withTransaction: mockWithTransaction,
}));

import { leaseEmbeddingJob } from '../repository.js';

describe('leaseEmbeddingJob SQL', () => {
  beforeEach(() => {
    mockClientQuery.mockReset();
    mockWithTransaction.mockReset();
    mockWithTransaction.mockImplementation(
      async (operation: (client: { query: typeof mockClientQuery }) => Promise<unknown>) =>
        operation({ query: mockClientQuery }),
    );
  });

  it('makes an expired in-progress lease available for a new claim', async () => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', user_id: 'user-1', page_id: 'page-1' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ title: 'Title', content: 'Body' }] });

    await expect(leaseEmbeddingJob()).resolves.toMatchObject({ id: 'job-1' });

    const [claimSql] = mockClientQuery.mock.calls[0] as [string];
    expect(claimSql).toContain(
      "status = 'pending' AND (leased_until IS NULL OR leased_until < now())",
    );
    expect(claimSql).toContain("status = 'in_progress' AND leased_until < now()");
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
  });
});
