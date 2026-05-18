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
    // 2nd call: UPDATE decision_outcomes with the new plan id.
    // No IS NULL guard — "latest plan wins" matches the migration
    // 055 backfill and getByDecisionId's ORDER BY created_at DESC
    // read semantics.
    const [updateSql, updateParams] = mockClientQuery.mock.calls[1]!;
    expect(updateSql).toContain('UPDATE decision_outcomes');
    expect(updateSql).toContain('SET execution_plan_id = $1');
    expect(updateSql).toContain('WHERE decision_id = $2');
    expect(updateSql).not.toMatch(/AND\s+execution_plan_id\s+IS\s+NULL/i);
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

  it('retry plans overwrite the outcome link — "latest plan wins"', async () => {
    // When a decision already has a linked plan and a
    // retry-after-rejection plan is created, the outcome's
    // execution_plan_id should point at the NEW plan. This matches:
    //   - the migration 055 backfill (ORDER BY created_at DESC, latest)
    //   - getByDecisionId's read semantics (ORDER BY created_at DESC LIMIT 1)
    //   - the conceptual model: the outcome's FK is the "current
    //     plan" pointer, not an immutable first-write record.
    // Historical plans remain reachable via
    // `SELECT * FROM execution_plans WHERE decision_id = ?`.
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ id: 'plan-retry', decision_id: 'd-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const plan = await executionRepository.createPlan({
      decisionId: 'd-1',
      actionId: 'a-2',
    });

    expect(plan.id).toBe('plan-retry');
    const [updateSql, updateParams] = mockClientQuery.mock.calls[1]!;
    // UPDATE always runs — no IS NULL guard means every new plan
    // overwrites the outcome's pointer to itself.
    expect(updateSql).not.toMatch(/AND\s+execution_plan_id\s+IS\s+NULL/i);
    expect(updateParams).toEqual(['plan-retry', 'd-1']);
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
