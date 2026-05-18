import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClientQuery = vi.fn();
const mockWithTransaction = vi.fn(
  async (cb: (client: { query: typeof mockClientQuery }) => Promise<unknown>) =>
    cb({ query: mockClientQuery }),
);

vi.mock('../connection.js', () => ({
  query: vi.fn(),
  withTransaction: (cb: (client: { query: typeof mockClientQuery }) => Promise<unknown>) =>
    mockWithTransaction(cb),
}));

const { executionRepository } = await import('../repositories/execution-repository.js');

describe('executionRepository.createPlan — #324 outcome linkage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links the matching outcome to the new plan in the same transaction', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ id: 'plan-1', decision_id: 'd-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const plan = await executionRepository.createPlan({
      decisionId: 'd-1',
      actionId: 'a-1',
    });

    expect(plan.id).toBe('plan-1');
    // 1st call: INSERT INTO execution_plans
    const [insertSql, insertParams] = mockClientQuery.mock.calls[0]!;
    expect(insertSql).toContain('INSERT INTO execution_plans');
    expect(insertParams).toEqual(['d-1', 'a-1', 'pending', '[]']);
    // 2nd call: UPDATE decision_outcomes with the new plan id
    const [updateSql, updateParams] = mockClientQuery.mock.calls[1]!;
    expect(updateSql).toContain('UPDATE decision_outcomes');
    expect(updateSql).toContain('SET execution_plan_id = $1');
    expect(updateSql).toContain('WHERE decision_id = $2');
    expect(updateSql).toContain('AND execution_plan_id IS NULL');
    expect(updateParams).toEqual(['plan-1', 'd-1']);
  });

  it('skips the outcome link UPDATE when decisionId is empty (defensive)', async () => {
    // The createPlan INSERT uses `input.decisionId || null` defensively —
    // an empty-string decisionId becomes a NULL decision_id (which the
    // schema would actually reject because the column is NOT NULL, but
    // the repo still guards just in case). The same falsy check is the
    // gate for the outcome link UPDATE: no decisionId, no UPDATE.
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ id: 'plan-2', decision_id: null }],
      rowCount: 1,
    });

    await executionRepository.createPlan({ decisionId: '', actionId: 'a-2' });

    // Only the INSERT call — no UPDATE.
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    const [insertSql] = mockClientQuery.mock.calls[0]!;
    expect(insertSql).toContain('INSERT INTO execution_plans');
  });

  it('UPDATE uses execution_plan_id IS NULL guard — retry plans cannot stomp original link', async () => {
    // When a decision already has a linked plan (e.g. the original
    // auto-execute plan), a retry-after-rejection plan should NOT
    // overwrite the original outcome's link. The IS NULL guard
    // enforces "first plan wins" — same semantics as
    // executionRepository.getByDecisionId's ORDER BY created_at LIMIT 1.
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ id: 'plan-retry', decision_id: 'd-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 }); // UPDATE matched 0 rows

    const plan = await executionRepository.createPlan({
      decisionId: 'd-1',
      actionId: 'a-2',
    });

    expect(plan.id).toBe('plan-retry');
    const [updateSql] = mockClientQuery.mock.calls[1]!;
    // The guard clause is the load-bearing line here — assert it's present.
    expect(updateSql).toContain('AND execution_plan_id IS NULL');
  });

  it('plan insert and outcome link share one transaction (both or neither lands)', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ id: 'plan-3', decision_id: 'd-3' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await executionRepository.createPlan({ decisionId: 'd-3', actionId: 'a-3' });

    // Single withTransaction call wraps both statements
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).toHaveBeenCalledTimes(2);
  });
});
