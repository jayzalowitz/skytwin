import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer so we can inspect the SQL `textSearch` builds without a
// live CockroachDB. repository.ts imports only `query` + `withTransaction`.
// `vi.hoisted` so the mock fn exists before the hoisted `vi.mock` factory runs.
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('@skytwin/db', () => ({
  query: mockQuery,
  withTransaction: vi.fn(),
}));

import { textSearch } from '../repository.js';

describe('textSearch SQL — ts_rank, not ts_rank_cd', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('uses ts_rank (CockroachDB-supported), NEVER ts_rank_cd (unimplemented on CRDB)', async () => {
    await textSearch('user-1', 'hello world', 5);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain('ts_rank(');
    // The whole reason this test exists: ts_rank_cd throws
    // "unimplemented: this function is not yet supported" on CockroachDB,
    // which silently degraded every semantic search to vector-only.
    expect(sql).not.toContain('ts_rank_cd');
  });

  it('uses the same ranking function on the authoring-tier-filtered variant', async () => {
    await textSearch('user-1', 'hello', 5, ['inbox_personal']);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain('ts_rank(');
    expect(sql).not.toContain('ts_rank_cd');
    expect(sql).toContain("metadata->>'authoringTier'");
  });

  it('short-circuits an empty / whitespace-only query without touching the DB', async () => {
    expect(await textSearch('u', '   ', 5)).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
