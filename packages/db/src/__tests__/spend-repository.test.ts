import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockWithTransaction = vi.fn(
  async (cb: (client: { query: typeof mockClientQuery }) => Promise<unknown>) =>
    cb({ query: mockClientQuery }),
);

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (cb: (client: { query: typeof mockClientQuery }) => Promise<unknown>) =>
    mockWithTransaction(cb),
}));

const { spendRepository } = await import('../repositories/spend-repository.js');

describe('spendRepository — registry_id wiring (#323)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('writes registry_id when provided', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'r-1' }], rowCount: 1 });
      await spendRepository.create({
        userId: 'u-1',
        actionId: 'a-1',
        decisionId: 'd-1',
        estimatedCostCents: 50,
        registryId: 'gmail-mcp',
      });
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO spend_records');
      expect(sql).toContain('registry_id');
      expect(params).toEqual(['u-1', 'a-1', 'd-1', 50, null, 'gmail-mcp']);
    });

    it('writes NULL registry_id when not provided', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'r-2' }], rowCount: 1 });
      await spendRepository.create({
        userId: 'u-2',
        actionId: 'a-2',
        decisionId: 'd-2',
        estimatedCostCents: 100,
      });
      const [, params] = mockQuery.mock.calls[0]!;
      expect(params).toEqual(['u-2', 'a-2', 'd-2', 100, null, null]);
    });
  });

  describe('getMonthlyTotal', () => {
    it('filters by registry_id when appRegistryId is provided', async () => {
      mockQuery.mockResolvedValue({ rows: [{ total: '750' }], rowCount: 1 });
      const total = await spendRepository.getMonthlyTotal('u-1', 'gmail-mcp');
      expect(total).toBe(750);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE user_id = $1');
      expect(sql).toContain('registry_id = $2');
      expect(sql).toContain("date_trunc('month', now())");
      expect(params).toEqual(['u-1', 'gmail-mcp']);
    });

    it('omits the registry filter when no appRegistryId is provided', async () => {
      mockQuery.mockResolvedValue({ rows: [{ total: '1200' }], rowCount: 1 });
      const total = await spendRepository.getMonthlyTotal('u-1');
      expect(total).toBe(1200);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE user_id = $1');
      expect(sql).not.toContain('registry_id');
      expect(params).toEqual(['u-1']);
    });

    it('returns 0 when no matching rows exist (per-app filter)', async () => {
      mockQuery.mockResolvedValue({ rows: [{ total: null }], rowCount: 1 });
      expect(await spendRepository.getMonthlyTotal('u-1', 'linear-mcp')).toBe(0);
    });

    it('treats empty-string appRegistryId as a real filter, not a missing one', async () => {
      // Empty string is technically a value, so it MUST hit the filtered
      // branch — sending an empty string to the unfiltered SUM would
      // silently widen the query to the user-global total, which is a
      // dangerous monitoring/billing bug. The repo uses `!== undefined`
      // (not falsiness) for this reason.
      mockQuery.mockResolvedValue({ rows: [{ total: '0' }], rowCount: 1 });
      await spendRepository.getMonthlyTotal('u-1', '');
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('registry_id = $2');
      expect(params).toEqual(['u-1', '']);
    });
  });

  describe('checkAndRecordSpend', () => {
    it('writes registry_id when provided alongside the atomic insert', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ total: '100' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'r-3' }], rowCount: 1 });

      const result = await spendRepository.checkAndRecordSpend(
        {
          userId: 'u-1',
          actionId: 'a-1',
          decisionId: 'd-1',
          estimatedCostCents: 50,
          registryId: 'slack-mcp',
        },
        1000,
      );

      expect(result.allowed).toBe(true);
      // First call reads current total (no registry param)
      const [, readParams] = mockClientQuery.mock.calls[0]!;
      expect(readParams).toEqual(['u-1', 24]);
      // Second call inserts including the registry_id
      const [insertSql, insertParams] = mockClientQuery.mock.calls[1]!;
      expect(insertSql).toContain('INSERT INTO spend_records');
      expect(insertSql).toContain('registry_id');
      expect(insertParams).toEqual(['u-1', 'a-1', 'd-1', 50, null, 'slack-mcp']);
    });

    it('writes NULL registry_id on the atomic insert when not provided', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'r-4' }], rowCount: 1 });

      await spendRepository.checkAndRecordSpend(
        { userId: 'u-2', actionId: 'a-2', decisionId: 'd-2', estimatedCostCents: 100 },
        1000,
      );

      const [, insertParams] = mockClientQuery.mock.calls[1]!;
      expect(insertParams).toEqual(['u-2', 'a-2', 'd-2', 100, null, null]);
    });
  });
});
