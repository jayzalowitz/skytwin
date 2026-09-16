import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const clientQuery = vi.fn();
const pooledQuery = vi.fn();
vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => pooledQuery(...args),
  withTransaction: async (fn: (client: { query: typeof clientQuery }) => Promise<unknown>) => fn({ query: clientQuery }),
}));
const { rollbackAdmissionRepository } = await import('../repositories/rollback-admission-repository.js');

const target = { candidate_action_id: 'a', decision_id: 'd', outcome_id: 'o', execution_result_id: 'r', adapter_name: 'ironclaw', provider_plan_id: 'provider-1' };
const admission = { id: 'ad', user_id: 'u', ...target, created_at: new Date() };

describe('rollbackAdmissionRepository', () => {
  beforeEach(() => { vi.clearAllMocks(); clientQuery.mockResolvedValue({ rows: [], rowCount: 0 }); });

  it('requires the complete exact target graph and does not infer missing identity', async () => {
    await expect(rollbackAdmissionRepository.admit({ userId: 'u', decisionId: 'd', candidateActionId: 'a', outcomeId: 'o', executionResultId: 'r', adapterName: '', providerPlanId: 'provider-1' })).rejects.toThrow('adapterName is required');
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('binds the execution plan to the same decision as the outcome', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [target] }).mockResolvedValueOnce({ rows: [{ id: 'ad' }] }).mockResolvedValueOnce({ rows: [admission] }).mockResolvedValueOnce({ rows: [] });
    await rollbackAdmissionRepository.admit({ userId: 'u', decisionId: 'd', candidateActionId: 'a', outcomeId: 'o', executionResultId: 'r', adapterName: 'ironclaw', providerPlanId: 'provider-1' });
    expect(clientQuery.mock.calls[0]![0]).toContain('ep.decision_id = d.id');
  });

  it('declares the explanation composite key before the terminal ledger FK', () => {
    const schema = readFileSync(new URL('../schemas/schema.sql', import.meta.url), 'utf8');
    expect(schema.indexOf('explanation_records_id_decision_idx')).toBeLessThan(schema.indexOf('rollback_terminal_explanation_fk'));
  });

  it('returns the existing claim as a non-winner on replay', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [target] }).mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [admission] }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const input = { userId: 'u', decisionId: 'd', candidateActionId: 'a', outcomeId: 'o', executionResultId: 'r', adapterName: 'ironclaw', providerPlanId: 'provider-1' };
    const first = await rollbackAdmissionRepository.admit(input);
    expect(first.created).toBe(false);
    expect(clientQuery.mock.calls[0]![0]).toContain("er.success = true");
    expect(clientQuery.mock.calls[0]![0]).toContain("er.outputs->>'adapter_plan_id'");
  });

  it('writes explanation and terminal ledger in the same transaction', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'd' }] }).mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [{ id: 'x' }] }).mockResolvedValueOnce({ rows: [{ admission_id: 'ad', user_id: 'u', decision_id: 'd', status: 'failed', result: {}, explanation_id: 'x', terminal_at: new Date() }] });
    const row = await rollbackAdmissionRepository.recordTerminal({ admissionId: 'ad', userId: 'u', decisionId: 'd', status: 'failed', explanation: { whatHappened: 'Rollback failed', confidenceReasoning: 'Provider response', actionRationale: 'Requested by user', correctionGuidance: 'Retry manually' } });
    expect(row.status).toBe('failed');
    expect(clientQuery.mock.calls[3]![0]).toContain('INSERT INTO explanation_records');
    expect(clientQuery.mock.calls[4]![0]).toContain('INSERT INTO rollback_terminal_ledger');
  });

  it('terminal replay is read-only', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ admission_id: 'ad', user_id: 'u', decision_id: 'd', status: 'rolled_back', result: {}, explanation_id: 'x', terminal_at: new Date() }] });
    await rollbackAdmissionRepository.recordTerminal({ admissionId: 'ad', userId: 'u', decisionId: 'd', status: 'unknown', explanation: { whatHappened: 'ignored', confidenceReasoning: 'ignored', actionRationale: 'ignored', correctionGuidance: 'ignored' } });
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it('rolls back the losing explanation before replaying a concurrent terminal', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'd' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'loser-explanation' }] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate terminal'), { code: '23505' }))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ admission_id: 'ad', user_id: 'u', decision_id: 'd', status: 'rolled_back', result: {}, explanation_id: 'winner-explanation', terminal_at: new Date() }] });
    const row = await rollbackAdmissionRepository.recordTerminal({ admissionId: 'ad', userId: 'u', decisionId: 'd', status: 'failed', explanation: { whatHappened: 'loser', confidenceReasoning: 'loser', actionRationale: 'loser', correctionGuidance: 'loser' } });
    expect(row.explanationId).toBe('winner-explanation');
    expect(clientQuery.mock.calls.map((call) => call[0])).toContain('ROLLBACK TO SAVEPOINT rollback_terminal_insert');
  });
});
