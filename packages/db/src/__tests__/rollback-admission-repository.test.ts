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

  it('rejects legacy terminalization before it can bypass the claim lifecycle', async () => {
    await expect(rollbackAdmissionRepository.recordTerminal({ admissionId: 'ad', userId: 'u', decisionId: 'd', status: 'failed', explanation: { whatHappened: 'Rollback failed', confidenceReasoning: 'Provider response', actionRationale: 'Requested by user', correctionGuidance: 'Retry manually' } })).rejects.toThrow('Legacy rollback terminalization is disabled');
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it('terminal replay is read-only', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ admission_id: 'ad', user_id: 'u', decision_id: 'd', status: 'rolled_back', result: {}, explanation_id: 'x', terminal_at: new Date() }] });
    await rollbackAdmissionRepository.recordTerminal({ admissionId: 'ad', userId: 'u', decisionId: 'd', status: 'unknown', explanation: { whatHappened: 'ignored', confidenceReasoning: 'ignored', actionRationale: 'ignored', correctionGuidance: 'ignored' } });
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it('does not query or write when a legacy terminalization has no existing terminal', async () => {
    await expect(rollbackAdmissionRepository.recordTerminal({ admissionId: 'ad', userId: 'u', decisionId: 'd', status: 'failed', explanation: { whatHappened: 'loser', confidenceReasoning: 'loser', actionRationale: 'loser', correctionGuidance: 'loser' } })).rejects.toThrow('Legacy rollback terminalization is disabled');
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it('claims once and returns busy while the bounded claim is live', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ lifecycle_status: 'admitted', claim_expires_at: null }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await rollbackAdmissionRepository.claim({ admissionId: 'ad', userId: 'u', decisionId: 'd', now: new Date('2026-01-01T00:00:00Z') });
    expect(result.kind).toBe('claimed');
    expect((result as { kind: 'claimed'; claim: { claimToken: string; claimExpiresAt: Date } }).claim.claimToken).toHaveLength(43);
    expect(clientQuery.mock.calls[2]![0]).toContain("lifecycle_status = 'claimed'");
  });

  it('recovers an expired claim to unknown with an explanation and terminal ledger', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ lifecycle_status: 'claimed', claim_expires_at: new Date('2025-12-31T23:59:00Z') }] })
      .mockResolvedValueOnce({ rows: [{ id: 'explanation' }] })
      .mockResolvedValueOnce({ rows: [{ admission_id: 'ad', user_id: 'u', decision_id: 'd', status: 'unknown', result: { reason: 'claim_expired' }, explanation_id: 'explanation', terminal_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await rollbackAdmissionRepository.claim({ admissionId: 'ad', userId: 'u', decisionId: 'd', now: new Date('2026-01-01T00:00:00Z') });
    expect(result).toMatchObject({ kind: 'terminal', terminal: { status: 'unknown', explanationId: 'explanation' } });
    expect(clientQuery.mock.calls[2]![0]).toContain('INSERT INTO explanation_records');
    expect(clientQuery.mock.calls[3]![0]).toContain("status, result, explanation_id");
    expect(clientQuery.mock.calls[4]![0]).toContain("lifecycle_status = 'terminal'");
  });
});
