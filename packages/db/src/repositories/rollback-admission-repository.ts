import { query, withTransaction } from '../connection.js';
import { createHash, randomBytes } from 'node:crypto';
import type { CreateExplanationInput } from './explanation-repository.js';

export type RollbackTerminalStatus = 'rolled_back' | 'failed' | 'unknown';
export interface RollbackAdmissionInput { userId: string; decisionId: string; candidateActionId: string; outcomeId: string; executionResultId: string; adapterName: string; providerPlanId: string; }
export type RollbackAdmissionLifecycleStatus = 'admitted' | 'claimed' | 'terminal';
export interface RollbackAdmissionRow extends RollbackAdmissionInput { id: string; createdAt: Date; lifecycleStatus: RollbackAdmissionLifecycleStatus; claimedAt: Date | null; claimExpiresAt: Date | null; terminalizedAt: Date | null; }
export interface RollbackClaimInput { admissionId: string; userId: string; decisionId: string; now?: Date; ttlMs?: number; }
export interface RollbackClaimRow { admissionId: string; userId: string; decisionId: string; claimToken: string; claimExpiresAt: Date; }
export type RollbackClaimResult = { kind: 'claimed'; claim: RollbackClaimRow } | { kind: 'terminal'; terminal: RollbackTerminalRow } | { kind: 'busy' };
export interface RollbackTerminalRow { admissionId: string; userId: string; decisionId: string; status: RollbackTerminalStatus; result: Record<string, unknown>; explanationId: string; terminalAt: Date; }
export interface RecordRollbackTerminalInput { admissionId: string; userId: string; decisionId: string; status: RollbackTerminalStatus; result?: Record<string, unknown>; explanation: Omit<CreateExplanationInput, 'decisionId'>; }

interface AdmissionDbRow { id: string; user_id: string; decision_id: string; candidate_action_id: string; outcome_id: string; execution_result_id: string; adapter_name: string; provider_plan_id: string; created_at: Date; lifecycle_status: RollbackAdmissionLifecycleStatus; claimed_at: Date | null; claim_expires_at: Date | null; terminalized_at: Date | null; }
interface TerminalDbRow { admission_id: string; user_id: string; decision_id: string; status: RollbackTerminalStatus; result: Record<string, unknown>; explanation_id: string; terminal_at: Date; }
const toAdmission = (r: AdmissionDbRow): RollbackAdmissionRow => ({ id: r.id, userId: r.user_id, decisionId: r.decision_id, candidateActionId: r.candidate_action_id, outcomeId: r.outcome_id, executionResultId: r.execution_result_id, adapterName: r.adapter_name, providerPlanId: r.provider_plan_id, createdAt: r.created_at, lifecycleStatus: r.lifecycle_status, claimedAt: r.claimed_at, claimExpiresAt: r.claim_expires_at, terminalizedAt: r.terminalized_at });
const toTerminal = (r: TerminalDbRow): RollbackTerminalRow => ({ admissionId: r.admission_id, userId: r.user_id, decisionId: r.decision_id, status: r.status, result: r.result, explanationId: r.explanation_id, terminalAt: r.terminal_at });
const hashClaim = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const CLAIM_TTL_MS = 2 * 60_000;

const TARGET_SQL = `SELECT ca.id AS candidate_action_id, d.id AS decision_id, doo.id AS outcome_id, er.id AS execution_result_id, er.outputs->>'adapter_used' AS adapter_name, er.outputs->>'adapter_plan_id' AS provider_plan_id FROM decisions d JOIN candidate_actions ca ON ca.decision_id = d.id AND ca.reversible = true JOIN decision_outcomes doo ON doo.decision_id = d.id AND doo.selected_action_id = ca.id JOIN execution_plans ep ON ep.id = doo.execution_plan_id AND ep.action_id = ca.id AND ep.decision_id = d.id JOIN execution_results er ON er.plan_id = ep.id AND er.success = true WHERE d.id = $1 AND d.user_id = $2 AND ca.id = $3 AND doo.id = $4 AND er.id = $5 AND er.rollback_available = true AND er.outputs->>'adapter_used' = $6 AND er.outputs->>'adapter_plan_id' = $7`;

export const rollbackAdmissionRepository = {
  async admit(input: RollbackAdmissionInput): Promise<{ admission: RollbackAdmissionRow; created: boolean; terminal: RollbackTerminalRow | null }> {
    for (const [key, value] of Object.entries(input)) if (!value) throw new Error(`Rollback admission ${key} is required.`);
    return withTransaction(async (client) => {
      const target = await client.query(TARGET_SQL + ' FOR UPDATE', [input.decisionId, input.userId, input.candidateActionId, input.outcomeId, input.executionResultId, input.adapterName, input.providerPlanId]);
      if (!target.rows[0]) throw new Error('Rollback target graph is not exact or is not owned by the user.');
      const inserted = await client.query<{ id: string }>(`INSERT INTO rollback_admissions (user_id, candidate_action_id, decision_outcome_id, execution_result_id, adapter_name, provider_plan_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (candidate_action_id) DO NOTHING RETURNING id`, [input.userId, input.candidateActionId, input.outcomeId, input.executionResultId, input.adapterName, input.providerPlanId]);
      const persisted = await client.query<AdmissionDbRow>(`SELECT ra.id, ra.user_id, d.id AS decision_id, ra.candidate_action_id, ra.decision_outcome_id AS outcome_id, ra.execution_result_id, ra.adapter_name, ra.provider_plan_id, ra.created_at, ra.lifecycle_status, ra.claimed_at, ra.claim_expires_at, ra.terminalized_at FROM rollback_admissions ra JOIN decision_outcomes o ON o.id = ra.decision_outcome_id JOIN decisions d ON d.id = o.decision_id WHERE ra.candidate_action_id = $1`, [input.candidateActionId]);
      const row = persisted.rows[0];
      if (!row || row.user_id !== input.userId || row.decision_id !== input.decisionId || row.outcome_id !== input.outcomeId || row.execution_result_id !== input.executionResultId || row.adapter_name !== input.adapterName || row.provider_plan_id !== input.providerPlanId) throw new Error('Existing rollback admission conflicts with the exact target graph.');
      const terminal = await client.query<TerminalDbRow>('SELECT * FROM rollback_terminal_ledger WHERE admission_id = $1', [row.id]);
      return { admission: toAdmission(row), created: inserted.rows.length > 0, terminal: terminal.rows[0] ? toTerminal(terminal.rows[0]) : null };
    });
  },
  async claim(input: RollbackClaimInput): Promise<RollbackClaimResult> {
    if (!input.admissionId || !input.userId || !input.decisionId) throw new Error('Rollback claim identity is required.');
    const now = input.now ?? new Date();
    const ttlMs = input.ttlMs ?? CLAIM_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > CLAIM_TTL_MS) throw new Error('Rollback claim TTL is outside the bounded limit.');
    return withTransaction(async (client) => {
      const current = await client.query<TerminalDbRow>('SELECT * FROM rollback_terminal_ledger WHERE admission_id = $1 AND user_id = $2 AND decision_id = $3', [input.admissionId, input.userId, input.decisionId]);
      if (current.rows[0]) return { kind: 'terminal', terminal: toTerminal(current.rows[0]) };
      const row = await client.query<{ lifecycle_status: RollbackAdmissionLifecycleStatus; claim_expires_at: Date | null }>(
        'SELECT lifecycle_status, claim_expires_at FROM rollback_admissions WHERE id = $1 AND user_id = $2 AND (SELECT d.id FROM decision_outcomes o JOIN decisions d ON d.id = o.decision_id WHERE o.id = rollback_admissions.decision_outcome_id) = $3 FOR UPDATE',
        [input.admissionId, input.userId, input.decisionId],
      );
      const admission = row.rows[0];
      if (!admission) throw new Error('Rollback admission is not owned by the user or decision.');
      if (admission.lifecycle_status === 'terminal') return { kind: 'busy' };
      if (admission.lifecycle_status === 'claimed') {
        if (admission.claim_expires_at && admission.claim_expires_at <= now) {
          const explanation = await client.query<{ id: string }>(`INSERT INTO explanation_records (decision_id, what_happened, evidence_used, preferences_invoked, confidence_reasoning, action_rationale, escalation_rationale, correction_guidance) VALUES ($1, $2, '[]', '{}', $3, $4, $5, $6) RETURNING id`, [input.decisionId, 'Rollback claim expired before terminal observation.', 'The single-use rollback authority expired without a durable provider result.', 'No rollback replay is authorized after claim expiry.', 'The rollback outcome is unknown and requires human review.', 'Do not retry this admission; inspect the provider independently.']);
          const terminal = await client.query<TerminalDbRow>(`INSERT INTO rollback_terminal_ledger (admission_id, user_id, decision_id, status, result, explanation_id) VALUES ($1, $2, $3, 'unknown', $4, $5) RETURNING *`, [input.admissionId, input.userId, input.decisionId, JSON.stringify({ reason: 'claim_expired' }), explanation.rows[0]!.id]);
          await client.query(`UPDATE rollback_admissions SET lifecycle_status = 'terminal', terminalized_at = $1 WHERE id = $2 AND lifecycle_status = 'claimed' AND claim_expires_at <= $1`, [now, input.admissionId]);
          return { kind: 'terminal', terminal: toTerminal(terminal.rows[0]!) };
        }
        return { kind: 'busy' };
      }
      const token = randomBytes(32).toString('base64url');
      const expires = new Date(now.getTime() + ttlMs);
      const updated = await client.query('UPDATE rollback_admissions SET lifecycle_status = \'claimed\', claim_token_hash = $1, claimed_at = $2, claim_expires_at = $3 WHERE id = $4 AND user_id = $5 AND lifecycle_status = \'admitted\'', [hashClaim(token), now, expires, input.admissionId, input.userId]);
      if (updated.rowCount !== 1) return { kind: 'busy' };
      return { kind: 'claimed', claim: { admissionId: input.admissionId, userId: input.userId, decisionId: input.decisionId, claimToken: token, claimExpiresAt: expires } };
    });
  },
  async terminalizeClaim(input: RecordRollbackTerminalInput & { claimToken: string; now?: Date }): Promise<RollbackTerminalRow> {
    if (!input.claimToken) throw new Error('Rollback claim token is required.');
    const now = input.now ?? new Date();
    return withTransaction(async (client) => {
      const replay = await client.query<TerminalDbRow>('SELECT * FROM rollback_terminal_ledger WHERE admission_id = $1 AND user_id = $2 AND decision_id = $3', [input.admissionId, input.userId, input.decisionId]);
      if (replay.rows[0]) return toTerminal(replay.rows[0]);
      const owned = await client.query<{ id: string }>(`SELECT id FROM rollback_admissions WHERE id = $1 AND user_id = $2 AND lifecycle_status = 'claimed' AND claim_token_hash = $3 AND claim_expires_at > $4 AND (SELECT d.id FROM decision_outcomes o JOIN decisions d ON d.id = o.decision_id WHERE o.id = rollback_admissions.decision_outcome_id) = $5 FOR UPDATE`, [input.admissionId, input.userId, hashClaim(input.claimToken), now, input.decisionId]);
      if (!owned.rows[0]) throw new Error('Rollback claim is expired, replayed, or not owned by the user.');
      const explanation = await client.query<{ id: string }>(`INSERT INTO explanation_records (decision_id, what_happened, evidence_used, preferences_invoked, confidence_reasoning, action_rationale, escalation_rationale, correction_guidance) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [input.decisionId, input.explanation.whatHappened, JSON.stringify(input.explanation.evidenceUsed ?? []), input.explanation.preferencesInvoked ?? [], input.explanation.confidenceReasoning, input.explanation.actionRationale, input.explanation.escalationRationale ?? null, input.explanation.correctionGuidance]);
      await client.query(`UPDATE rollback_admissions SET lifecycle_status = 'terminal', terminalized_at = $1, claim_token_hash = NULL WHERE id = $2 AND lifecycle_status = 'claimed' AND claim_token_hash = $3`, [now, input.admissionId, hashClaim(input.claimToken)]);
      const terminal = await client.query<TerminalDbRow>(`INSERT INTO rollback_terminal_ledger (admission_id, user_id, decision_id, status, result, explanation_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [input.admissionId, input.userId, input.decisionId, input.status, JSON.stringify(input.result ?? {}), explanation.rows[0]!.id]);
      return toTerminal(terminal.rows[0]!);
    });
  },
  async recordTerminal(input: RecordRollbackTerminalInput): Promise<RollbackTerminalRow> {
    return withTransaction(async (client) => {
      const existing = await client.query<TerminalDbRow>('SELECT * FROM rollback_terminal_ledger WHERE admission_id = $1 AND user_id = $2 AND decision_id = $3', [input.admissionId, input.userId, input.decisionId]);
      if (existing.rows[0]) return toTerminal(existing.rows[0]);
      const owned = await client.query('SELECT d.id FROM rollback_admissions ra JOIN decision_outcomes o ON o.id = ra.decision_outcome_id JOIN decisions d ON d.id = o.decision_id WHERE ra.id = $1 AND ra.user_id = $2 AND d.id = $3', [input.admissionId, input.userId, input.decisionId]);
      if (!owned.rows[0]) throw new Error('Rollback admission is not owned by the user.');
      await client.query('SAVEPOINT rollback_terminal_insert');
      const explanation = await client.query<{ id: string }>(`INSERT INTO explanation_records (decision_id, what_happened, evidence_used, preferences_invoked, confidence_reasoning, action_rationale, escalation_rationale, correction_guidance) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [input.decisionId, input.explanation.whatHappened, JSON.stringify(input.explanation.evidenceUsed ?? []), input.explanation.preferencesInvoked ?? [], input.explanation.confidenceReasoning, input.explanation.actionRationale, input.explanation.escalationRationale ?? null, input.explanation.correctionGuidance]);
      try {
        const inserted = await client.query<TerminalDbRow>(`INSERT INTO rollback_terminal_ledger (admission_id, user_id, decision_id, status, result, explanation_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [input.admissionId, input.userId, input.decisionId, input.status, JSON.stringify(input.result ?? {}), explanation.rows[0]!.id]);
        return toTerminal(inserted.rows[0]!);
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        await client.query('ROLLBACK TO SAVEPOINT rollback_terminal_insert');
        const replay = await client.query<TerminalDbRow>('SELECT * FROM rollback_terminal_ledger WHERE admission_id = $1', [input.admissionId]);
        if (!replay.rows[0]) throw error;
        return toTerminal(replay.rows[0]);
      } finally {
        await client.query('RELEASE SAVEPOINT rollback_terminal_insert').catch(() => undefined);
      }
    });
  },
  async getTerminal(admissionId: string, userId: string): Promise<RollbackTerminalRow | null> {
    const result = await query<TerminalDbRow>('SELECT * FROM rollback_terminal_ledger WHERE admission_id = $1 AND user_id = $2', [admissionId, userId]);
    return result.rows[0] ? toTerminal(result.rows[0]) : null;
  },
};
