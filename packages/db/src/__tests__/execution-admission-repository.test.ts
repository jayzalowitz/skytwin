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
  created_at: new Date('2026-09-13T00:00:00Z'),
  updated_at: new Date('2026-09-13T00:00:00Z'),
};
const BARRIER = {
  id: '55555555-5555-4555-8555-555555555555',
  user_id: '11111111-1111-4111-8111-111111111111',
  scope: 'memory' as const,
  idempotency_key: '22222222-2222-4222-8222-222222222222',
  decision_id: '33333333-3333-4333-8333-333333333333',
  action_id: '66666666-6666-4666-8666-666666666666',
  execution_plan_id: PLAN.id,
  outcome_id: '77777777-7777-4777-8777-777777777777',
  explanation_id: '88888888-8888-4888-8888-888888888888',
  risk_snapshot: { actionId: PLAN.action_id, overallTier: 'low' },
  policy_snapshot: { allowed: true },
  status: 'in_progress' as const,
  observed_result: {},
  created_at: new Date('2026-09-13T00:00:00Z'),
  updated_at: new Date('2026-09-13T00:00:00Z'),
};
const MEMORY_EVIDENCE = {
  riskSnapshot: BARRIER.risk_snapshot,
  policySnapshot: BARRIER.policy_snapshot,
  preEffectOutcome: { explanation: 'admitted before dispatch', confidence: 0.9 },
  preEffectExplanation: {
    whatHappened: 'admitted before dispatch',
    confidenceReasoning: 'low risk',
    actionRationale: 'test action',
    correctionGuidance: 'review it',
  },
};

describe('executionAdmissionRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('atomically admits a memory execution and freezes the opportunity before dispatch', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [{ id: BARRIER.user_id }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: BARRIER.idempotency_key, risk_assessment: BARRIER.risk_snapshot }] })
      .mockResolvedValueOnce({ rows: [{ id: BARRIER.outcome_id }] })
      .mockResolvedValueOnce({ rows: [{ id: BARRIER.explanation_id }] })
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
      ...MEMORY_EVIDENCE,
      report,
    })).resolves.toMatchObject({ created: true, barrier: BARRIER, plan: PLAN });

    expect(mockTransactionQuery.mock.calls[3]![0]).toContain('INSERT INTO decision_outcomes');
    expect(mockTransactionQuery.mock.calls[4]![0]).toContain('INSERT INTO explanation_records');
    expect(mockTransactionQuery.mock.calls[5]![0]).toContain('INSERT INTO execution_plans');
    expect(mockTransactionQuery.mock.calls[6]![0]).toContain('INSERT INTO execution_admission_barriers');
    expect(mockTransactionQuery.mock.calls[7]![0]).toContain("status = 'execution_ambiguous'");
    expect(mockTransactionQuery.mock.calls[7]![0]).toContain('execution_plan_id = $5');
  });

  it('returns an existing admission without creating a second plan', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [{ id: BARRIER.user_id }] })
      .mockResolvedValueOnce({ rows: [BARRIER] })
      .mockResolvedValueOnce({ rows: [PLAN] });

    const result = await executionAdmissionRepository.admitMemoryExecution({
      userId: BARRIER.user_id,
      opportunityId: BARRIER.idempotency_key,
      decisionId: BARRIER.decision_id,
      actionId: BARRIER.action_id,
      steps: [{ type: 'create_task', status: 'pending' }],
      ...MEMORY_EVIDENCE,
      report: {
        opportunityId: BARRIER.idempotency_key,
        status: 'execution_ambiguous',
        title: 'Test', actionType: 'create_task', actionLabel: 'Create task',
        summary: 'admitted', nextStep: 'reconcile', attemptedAt: new Date().toISOString(),
      },
    });

    expect(result.created).toBe(false);
    expect(mockTransactionQuery).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['decision', { decisionId: '77777777-7777-4777-8777-777777777777' }],
    ['action', { actionId: '88888888-8888-4888-8888-888888888888' }],
    ['steps', { steps: [{ type: 'different', status: 'pending' }] }],
    ['risk snapshot', { riskSnapshot: { actionId: PLAN.action_id, overallTier: 'high' } }],
    ['policy snapshot', { policySnapshot: { allowed: false } }],
  ])('rejects an existing admission with conflicting %s authority', async (_label, override) => {
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [{ id: BARRIER.user_id }] })
      .mockResolvedValueOnce({ rows: [BARRIER] })
      .mockResolvedValueOnce({ rows: [PLAN] });

    await expect(executionAdmissionRepository.admitMemoryExecution({
      userId: BARRIER.user_id,
      opportunityId: BARRIER.idempotency_key,
      decisionId: BARRIER.decision_id,
      actionId: BARRIER.action_id,
      steps: [{ type: 'create_task', status: 'pending' }],
      ...MEMORY_EVIDENCE,
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
        riskSnapshot: BARRIER.risk_snapshot,
        policySnapshot: BARRIER.policy_snapshot,
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

  it('requires the exact live owner, graph, explanation, and plan before dispatch', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BARRIER.id }] });
    await expect(executionAdmissionRepository.isDispatchable({
      barrier: BARRIER,
      plan: PLAN,
      created: true,
    })).resolves.toBe(true);
    expect(mockQuery.mock.calls[0]![0]).toContain("b.status = 'in_progress'");
    expect(mockQuery.mock.calls[0]![0]).toContain("ep.status = 'running'");

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(executionAdmissionRepository.isDispatchable({
      barrier: BARRIER,
      plan: PLAN,
      created: true,
    })).resolves.toBe(false);
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
