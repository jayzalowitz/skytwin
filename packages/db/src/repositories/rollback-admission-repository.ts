import { query, withTransaction } from '../connection.js';
import type { CreateExplanationInput } from './explanation-repository.js';

export type RollbackTerminalStatus = 'rolled_back' | 'failed' | 'unknown';
export interface RollbackAdmissionInput { userId: string; decisionId: string; candidateActionId: string; outcomeId: string; executionResultId: string; adapterName: string; providerPlanId: string; }
export interface RollbackAdmissionRow extends RollbackAdmissionInput { id: string; createdAt: Date; }
export interface RollbackTerminalRow { admissionId: string; userId: string; decisionId: string; status: RollbackTerminalStatus; result: Record<string, unknown>; explanationId: string; terminalAt: Date; }
export interface RecordRollbackTerminalInput { admissionId: string; userId: string; decisionId: string; status: RollbackTerminalStatus; result?: Record<string, unknown>; explanation: Omit<CreateExplanationInput, 'decisionId'>; }

interface AdmissionDbRow { id: string; user_id: string; decision_id: string; candidate_action_id: string; outcome_id: string; execution_result_id: string; adapter_name: string; provider_plan_id: string; created_at: Date; }
interface TerminalDbRow { admission_id: string; user_id: string; decision_id: string; status: RollbackTerminalStatus; result: Record<string, unknown>; explanation_id: string; terminal_at: Date; }
const toAdmission = (r: AdmissionDbRow): RollbackAdmissionRow => ({ id: r.id, userId: r.user_id, decisionId: r.decision_id, candidateActionId: r.candidate_action_id, outcomeId: r.outcome_id, executionResultId: r.execution_result_id, adapterName: r.adapter_name, providerPlanId: r.provider_plan_id, createdAt: r.created_at });
const toTerminal = (r: TerminalDbRow): RollbackTerminalRow => ({ admissionId: r.admission_id, userId: r.user_id, decisionId: r.decision_id, status: r.status, result: r.result, explanationId: r.explanation_id, terminalAt: r.terminal_at });

const TARGET_SQL = `SELECT ca.id AS candidate_action_id, d.id AS decision_id, doo.id AS outcome_id, er.id AS execution_result_id, er.outputs->>'adapter_used' AS adapter_name, er.outputs->>'adapter_plan_id' AS provider_plan_id FROM decisions d JOIN candidate_actions ca ON ca.decision_id = d.id AND ca.reversible = true JOIN decision_outcomes doo ON doo.decision_id = d.id AND doo.selected_action_id = ca.id JOIN execution_plans ep ON ep.id = doo.execution_plan_id AND ep.action_id = ca.id JOIN execution_results er ON er.plan_id = ep.id AND er.success = true WHERE d.id = $1 AND d.user_id = $2 AND ca.id = $3 AND doo.id = $4 AND er.id = $5 AND er.rollback_available = true AND er.outputs->>'adapter_used' = $6 AND er.outputs->>'adapter_plan_id' = $7`;

export const rollbackAdmissionRepository = {
  async admit(input: RollbackAdmissionInput): Promise<{ admission: RollbackAdmissionRow; created: boolean; terminal: RollbackTerminalRow | null }> {
    for (const [key, value] of Object.entries(input)) if (!value) throw new Error(`Rollback admission ${key} is required.`);
    return withTransaction(async (client) => {
      const target = await client.query(TARGET_SQL + ' FOR UPDATE', [input.decisionId, input.userId, input.candidateActionId, input.outcomeId, input.executionResultId, input.adapterName, input.providerPlanId]);
      if (!target.rows[0]) throw new Error('Rollback target graph is not exact or is not owned by the user.');
      const inserted = await client.query<{ id: string }>(`INSERT INTO rollback_admissions (user_id, candidate_action_id, decision_outcome_id, execution_result_id, adapter_name, provider_plan_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (candidate_action_id) DO NOTHING RETURNING id`, [input.userId, input.candidateActionId, input.outcomeId, input.executionResultId, input.adapterName, input.providerPlanId]);
      const persisted = await client.query<AdmissionDbRow>(`SELECT ra.id, ra.user_id, d.id AS decision_id, ra.candidate_action_id, ra.decision_outcome_id AS outcome_id, ra.execution_result_id, ra.adapter_name, ra.provider_plan_id, ra.created_at FROM rollback_admissions ra JOIN decision_outcomes o ON o.id = ra.decision_outcome_id JOIN decisions d ON d.id = o.decision_id WHERE ra.candidate_action_id = $1`, [input.candidateActionId]);
      const row = persisted.rows[0];
      if (!row || row.user_id !== input.userId || row.decision_id !== input.decisionId || row.outcome_id !== input.outcomeId || row.execution_result_id !== input.executionResultId || row.adapter_name !== input.adapterName || row.provider_plan_id !== input.providerPlanId) throw new Error('Existing rollback admission conflicts with the exact target graph.');
      const terminal = await client.query<TerminalDbRow>('SELECT * FROM rollback_terminal_ledger WHERE admission_id = $1', [row.id]);
      return { admission: toAdmission(row), created: inserted.rows.length > 0, terminal: terminal.rows[0] ? toTerminal(terminal.rows[0]) : null };
    });
  },
  async recordTerminal(input: RecordRollbackTerminalInput): Promise<RollbackTerminalRow> {
    return withTransaction(async (client) => {
      const existing = await client.query<TerminalDbRow>('SELECT * FROM rollback_terminal_ledger WHERE admission_id = $1 AND user_id = $2 AND decision_id = $3', [input.admissionId, input.userId, input.decisionId]);
      if (existing.rows[0]) return toTerminal(existing.rows[0]);
      const owned = await client.query('SELECT d.id FROM rollback_admissions ra JOIN decision_outcomes o ON o.id = ra.decision_outcome_id JOIN decisions d ON d.id = o.decision_id WHERE ra.id = $1 AND ra.user_id = $2 AND d.id = $3', [input.admissionId, input.userId, input.decisionId]);
      if (!owned.rows[0]) throw new Error('Rollback admission is not owned by the user.');
      const explanation = await client.query<{ id: string }>(`INSERT INTO explanation_records (decision_id, what_happened, evidence_used, preferences_invoked, confidence_reasoning, action_rationale, escalation_rationale, correction_guidance) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [input.decisionId, input.explanation.whatHappened, JSON.stringify(input.explanation.evidenceUsed ?? []), input.explanation.preferencesInvoked ?? [], input.explanation.confidenceReasoning, input.explanation.actionRationale, input.explanation.escalationRationale ?? null, input.explanation.correctionGuidance]);
      await client.query('SAVEPOINT rollback_terminal_insert');
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
