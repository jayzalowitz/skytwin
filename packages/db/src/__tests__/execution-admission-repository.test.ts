import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockTransactionQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockTransactionQuery: vi.fn(),
}));

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (fn: (client: { query: typeof mockTransactionQuery }) => Promise<unknown>) =>
    fn({ query: mockTransactionQuery }),
}));

const { executionAdmissionRepository } = await import(
  '../repositories/execution-admission-repository.js'
);

const PLAN = {
  id: '44444444-4444-4444-8444-444444444444',
  decision_id: '33333333-3333-4333-8333-333333333333',
  action_id: '66666666-6666-4666-8666-666666666666',
  status: 'running',
  steps: [{ status: 'pending', type: 'create_task' }],
};
const BARRIER = {
  id: '55555555-5555-4555-8555-555555555555',
  user_id: '11111111-1111-4111-8111-111111111111',
  scope: 'memory',
  idempotency_key: '22222222-2222-4222-8222-222222222222',
  decision_id: '33333333-3333-4333-8333-333333333333',
  action_id: '66666666-6666-4666-8666-666666666666',
  execution_plan_id: PLAN.id,
  status: 'in_progress',
  observed_result: {},
};

describe('executionAdmissionRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('atomically admits a memory execution and freezes the opportunity before dispatch', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: BARRIER.idempotency_key }] })
      .mockResolvedValueOnce({ rows: [PLAN] })
      .mockResolvedValueOnce({ rows: [BARRIER] })
      .mockResolvedValueOnce({ rows: [{ id: BARRIER.idempotency_key }] });
    const report = {
      opportunityId: BARRIER.idempotency_key,
      status: 'execution_ambiguous' as const,
      title: 'Test',
      actionType: 'create_task',
      actionLabel: 'Create task',
      summary: 'admitted',
      nextStep: 'reconcile',
      attemptedAt: new Date().toISOString(),
    };

    await expect(executionAdmissionRepository.admitMemoryExecution({
      userId: BARRIER.user_id,
      opportunityId: BARRIER.idempotency_key,
      decisionId: BARRIER.decision_id,
      actionId: BARRIER.action_id,
      steps: [{ type: 'create_task', status: 'pending' }],
      report,
    })).resolves.toMatchObject({ created: true, barrier: BARRIER, plan: PLAN });

    expect(mockTransactionQuery.mock.calls[4]![0]).toContain("status = 'execution_ambiguous'");
    expect(mockTransactionQuery.mock.calls[4]![0]).toContain('execution_plan_id = $5');
  });

  it('returns an existing admission without creating a second plan', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [BARRIER] })
      .mockResolvedValueOnce({ rows: [PLAN] });

    const result = await executionAdmissionRepository.admitMemoryExecution({
      userId: BARRIER.user_id,
      opportunityId: BARRIER.idempotency_key,
      decisionId: BARRIER.decision_id,
      actionId: BARRIER.action_id,
      steps: [{ type: 'create_task', status: 'pending' }],
      report: {
        opportunityId: BARRIER.idempotency_key,
        status: 'execution_ambiguous',
        title: 'Test', actionType: 'create_task', actionLabel: 'Create task',
        summary: 'admitted', nextStep: 'reconcile', attemptedAt: new Date().toISOString(),
      },
    });

    expect(result.created).toBe(false);
    expect(mockTransactionQuery).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['decision', { decisionId: '77777777-7777-4777-8777-777777777777' }],
    ['action', { actionId: '88888888-8888-4888-8888-888888888888' }],
    ['steps', { steps: [{ type: 'different', status: 'pending' }] }],
  ])('rejects an existing admission with conflicting %s authority', async (_label, override) => {
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [BARRIER] })
      .mockResolvedValueOnce({ rows: [PLAN] });

    await expect(executionAdmissionRepository.admitMemoryExecution({
      userId: BARRIER.user_id,
      opportunityId: BARRIER.idempotency_key,
      decisionId: BARRIER.decision_id,
      actionId: BARRIER.action_id,
      steps: [{ type: 'create_task', status: 'pending' }],
      report: {
        opportunityId: BARRIER.idempotency_key,
        status: 'execution_ambiguous',
        title: 'Test', actionType: 'create_task', actionLabel: 'Create task',
        summary: 'admitted', nextStep: 'reconcile', attemptedAt: new Date().toISOString(),
      },
      ...override,
    })).rejects.toThrow('conflicts with requested authority');
  });

  it('recovers the exact admitted plan by owner and scope after commit-response loss', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [BARRIER] })
      .mockResolvedValueOnce({ rows: [PLAN] });

    await expect(executionAdmissionRepository.findByScope(
      BARRIER.user_id,
      'memory',
      BARRIER.idempotency_key,
      {
        userId: BARRIER.user_id,
        decisionId: BARRIER.decision_id,
        actionId: BARRIER.action_id,
        steps: [{ type: 'create_task', status: 'pending' }],
      },
    )).resolves.toMatchObject({ created: false, barrier: BARRIER, plan: PLAN });
    expect(mockQuery.mock.calls[0]![1]).toEqual([
      BARRIER.user_id, 'memory', BARRIER.idempotency_key,
    ]);
  });

  it('accepts exact terminal reconciliation and rejects conflicting truth', async () => {
    const observed = { planId: PLAN.id, status: 'completed' };
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ ...BARRIER, status: 'completed', observed_result: observed }],
    });
    await expect(executionAdmissionRepository.observeTerminal({
      id: BARRIER.id,
      userId: BARRIER.user_id,
      status: 'completed',
      result: observed,
    })).resolves.toMatchObject({ status: 'completed' });

    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ ...BARRIER, status: 'completed', observed_result: observed }],
    });
    await expect(executionAdmissionRepository.observeTerminal({
      id: BARRIER.id,
      userId: BARRIER.user_id,
      status: 'failed',
      result: { planId: PLAN.id, status: 'failed' },
    })).rejects.toThrow('conflicts with its observed result');
  });

  it('rejects a terminal observation whose plan or status is not explicit', async () => {
    await expect(executionAdmissionRepository.observeTerminal({
      id: BARRIER.id,
      userId: BARRIER.user_id,
      status: 'completed',
      result: { planId: PLAN.id, status: 'failed' },
    })).rejects.toThrow('does not match its terminal status');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
