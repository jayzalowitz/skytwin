import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { mcpServerRepository } = await import('../repositories/mcp-server-repository.js');

describe('mcpServerRepository.markResumedForUserByIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not query when the classified set is empty', async () => {
    await expect(mcpServerRepository.markResumedForUserByIds('user-1', []))
      .resolves.toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('keeps owner and paused-state predicates in the conditional update', async () => {
    const returned = { id: 'server-1', status: 'active' };
    mockQuery.mockResolvedValueOnce({ rows: [returned], rowCount: 1 });

    await expect(mcpServerRepository.markResumedForUserByIds(
      'user-1',
      ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    )).resolves.toEqual([returned]);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE user_id = $1');
    expect(sql).toContain("AND status = 'paused'");
    expect(sql).toContain('AND id = ANY($2::uuid[])');
    expect(params).toEqual(['user-1', ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']]);
  });
});
