import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../connection.js', () => ({ query: (...args: unknown[]) => mockQuery(...args) }));

const { preEffectBarrierRepository } = await import(
  '../repositories/pre-effect-barrier-repository.js'
);

const ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  effect_type: 'memory_execution' as const,
  idempotency_key: 'opportunity-1',
  status: 'reserved' as const,
  decision_id: null,
  action_id: null,
  explanation_id: null,
  policy_snapshot: {},
  effect_result: {},
  failure_reason: null,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('preEffectBarrierRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reserves by user, effect type, and stable idempotency key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] });
    const result = await preEffectBarrierRepository.reserve({
      userId: ROW.user_id,
      effectType: ROW.effect_type,
      idempotencyKey: ROW.idempotency_key,
    });

    expect(result.created).toBe(true);
    expect(mockQuery.mock.calls[0]![0]).toContain(
      'ON CONFLICT (user_id, effect_type, idempotency_key) DO NOTHING',
    );
  });

  it('returns the durable prior row to suppress a replay', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...ROW, status: 'in_progress' }] });
    const result = await preEffectBarrierRepository.reserve({
      userId: ROW.user_id,
      effectType: ROW.effect_type,
      idempotencyKey: ROW.idempotency_key,
    });

    expect(result.created).toBe(false);
    expect(result.row.status).toBe('in_progress');
  });

  it('claims only a fully prepared barrier', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, status: 'in_progress' }] });
    await preEffectBarrierRepository.claimPrepared(ROW.user_id, ROW.id);

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("WHERE id = $1 AND user_id = $2 AND status = 'prepared'");
    expect(sql).toContain("SET status = 'in_progress'");
  });

  it('scopes every mutation to the owning user and a compare-and-set status', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...ROW, status: 'prepared' }] });
    await preEffectBarrierRepository.markPrepared({
      id: ROW.id,
      userId: ROW.user_id,
      decisionId: '33333333-3333-3333-3333-333333333333',
      actionId: '44444444-4444-4444-4444-444444444444',
      explanationId: '55555555-5555-5555-5555-555555555555',
      policySnapshot: { allowed: true },
    });
    await preEffectBarrierRepository.updatePreparedPolicy(ROW.user_id, ROW.id, { allowed: false });
    await preEffectBarrierRepository.markTerminal(ROW.user_id, ROW.id, 'blocked');

    for (const [sql, params] of mockQuery.mock.calls) {
      expect(sql).toContain('user_id = $2');
      expect(params[1]).toBe(ROW.user_id);
    }
  });

  it('fails closed when a barrier cannot transition to prepared', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(preEffectBarrierRepository.markPrepared({
      id: ROW.id,
      userId: ROW.user_id,
      decisionId: '33333333-3333-3333-3333-333333333333',
      actionId: '44444444-4444-4444-4444-444444444444',
      explanationId: '55555555-5555-5555-5555-555555555555',
      policySnapshot: { allowed: true },
    })).rejects.toThrow('not reserved');
  });

  it('binds preparation to one owned decision, action, and explanation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, status: 'prepared' }] });
    await preEffectBarrierRepository.markPrepared({
      id: ROW.id,
      userId: ROW.user_id,
      decisionId: '33333333-3333-3333-3333-333333333333',
      actionId: '44444444-4444-4444-4444-444444444444',
      explanationId: '55555555-5555-5555-5555-555555555555',
      policySnapshot: { allowed: true },
    });

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('action.decision_id = decision.id');
    expect(sql).toContain('explanation.decision_id = decision.id');
    expect(sql).toContain('decision.id = $3 AND decision.user_id = $2');
  });

  it.each([
    'same-user explanation from another decision',
    'cross-user explanation',
  ])('rejects %s during terminal attachment', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(preEffectBarrierRepository.markTerminalWithExplanation({
      id: ROW.id,
      userId: ROW.user_id,
      explanationId: '55555555-5555-5555-5555-555555555555',
      decisionId: '33333333-3333-3333-3333-333333333333',
      actionId: '44444444-4444-4444-4444-444444444444',
      status: 'failed',
      failureReason: 'execution_pipeline_failed',
    })).rejects.toThrow('Owned explanation');

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('decision.id = $4');
    expect(sql).toContain('decision.user_id = $2');
    expect(sql).toContain('barrier.decision_id IS NULL OR barrier.decision_id = $4');
  });

  it('accepts terminal attachment only when the candidate belongs to the exact owned decision', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      ...ROW,
      status: 'failed',
      decision_id: '33333333-3333-3333-3333-333333333333',
      action_id: '44444444-4444-4444-4444-444444444444',
      explanation_id: '55555555-5555-5555-5555-555555555555',
    }] });

    await expect(preEffectBarrierRepository.markTerminalWithExplanation({
      id: ROW.id,
      userId: ROW.user_id,
      explanationId: '55555555-5555-5555-5555-555555555555',
      decisionId: '33333333-3333-3333-3333-333333333333',
      actionId: '44444444-4444-4444-4444-444444444444',
      status: 'failed',
      failureReason: 'execution_pipeline_failed',
    })).resolves.toMatchObject({
      decision_id: '33333333-3333-3333-3333-333333333333',
      action_id: '44444444-4444-4444-4444-444444444444',
    });

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('JOIN candidate_actions AS action');
    expect(sql).toContain('action.id = $5 AND action.decision_id = decision.id');
    expect(sql).toContain('decision.id = $4 AND decision.user_id = $2');
    expect(sql).toContain('explanation.id = $3 AND explanation.decision_id = decision.id');
  });

  it.each([
    {
      label: 'same-user candidate from another decision',
      actionId: '66666666-6666-6666-6666-666666666666',
    },
    {
      label: 'cross-user candidate',
      actionId: '77777777-7777-7777-7777-777777777777',
    },
  ])('rejects $label during terminal attachment', async ({ actionId }) => {
    // PostgreSQL returns no UPDATE row when the candidate/decision/user join
    // cannot prove exact ownership. Both adversarial cases therefore share the
    // repository's fail-closed result while the SQL assertions below preserve
    // the linkage that distinguishes them from an unscoped candidate lookup.
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(preEffectBarrierRepository.markTerminalWithExplanation({
      id: ROW.id,
      userId: ROW.user_id,
      explanationId: '55555555-5555-5555-5555-555555555555',
      decisionId: '33333333-3333-3333-3333-333333333333',
      actionId,
      status: 'blocked',
      failureReason: 'policy_blocked',
    })).rejects.toThrow('Owned explanation');

    const sql = mockQuery.mock.calls[0]![0] as string;
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(sql).toContain('action.id = $5 AND action.decision_id = decision.id');
    expect(sql).toContain('decision.id = $4 AND decision.user_id = $2');
    expect(params[4]).toBe(actionId);
  });
});
