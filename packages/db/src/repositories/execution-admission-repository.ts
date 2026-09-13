import { normalizeExecutionRecord, type MemoryActionLoopReport } from '@skytwin/shared-types';
import { query, withTransaction } from '../connection.js';
import type { CreateExplanationInput } from './explanation-repository.js';
import type { ExecutionPlanRow } from '../types.js';

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export type ExecutionAdmissionScope = 'memory' | 'approval';
export type ExecutionAdmissionStatus = 'in_progress' | 'completed' | 'failed' | 'ambiguous';

export interface ExecutionAdmissionRow {
  id: string;
  user_id: string;
  scope: ExecutionAdmissionScope;
  idempotency_key: string;
  decision_id: string;
  action_id: string;
  execution_plan_id: string;
  outcome_id: string;
  explanation_id: string;
  risk_snapshot: Record<string, unknown>;
  policy_snapshot: Record<string, unknown>;
  action_snapshot: Record<string, unknown>;
  outcome_snapshot: Record<string, unknown>;
  status: ExecutionAdmissionStatus;
  observed_result: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface AdmitExecutionInput {
  userId: string;
  decisionId: string;
  actionId: string;
  steps: unknown[];
  riskSnapshot: Record<string, unknown>;
  policySnapshot: Record<string, unknown>;
  actionSnapshot: Record<string, unknown>;
  outcomeSnapshot: Record<string, unknown>;
}

function assertSnapshotAuthority(input: AdmitExecutionInput): void {
  if (input.actionSnapshot['id'] !== input.actionId ||
      input.actionSnapshot['decisionId'] !== input.decisionId ||
      input.riskSnapshot['actionId'] !== input.actionId ||
      input.outcomeSnapshot['decisionId'] !== input.decisionId ||
      input.outcomeSnapshot['autoExecute'] !== true ||
      input.outcomeSnapshot['requiresApproval'] !== false ||
      canonicalJson(input.outcomeSnapshot['selectedAction']) !== canonicalJson(input.actionSnapshot)) {
    throw new Error('Execution admission snapshots conflict with requested authority.');
  }
}

function assertExactAdmission(
  barrier: ExecutionAdmissionRow,
  plan: ExecutionPlanRow,
  input: AdmitExecutionInput,
): void {
  const persistedSteps = JSON.parse(JSON.stringify(input.steps)) as unknown[];
  const persistedRisk = JSON.parse(JSON.stringify(input.riskSnapshot)) as Record<string, unknown>;
  const persistedPolicy = JSON.parse(JSON.stringify(input.policySnapshot)) as Record<string, unknown>;
  const persistedAction = JSON.parse(JSON.stringify(input.actionSnapshot)) as Record<string, unknown>;
  const persistedOutcome = JSON.parse(JSON.stringify(input.outcomeSnapshot)) as Record<string, unknown>;
  if (
    barrier.user_id !== input.userId ||
    barrier.execution_plan_id !== plan.id ||
    barrier.decision_id !== input.decisionId ||
    barrier.action_id !== input.actionId ||
    plan.decision_id !== input.decisionId ||
    plan.action_id !== input.actionId ||
    canonicalJson(barrier.risk_snapshot) !== canonicalJson(persistedRisk) ||
    canonicalJson(barrier.policy_snapshot) !== canonicalJson(persistedPolicy) ||
    canonicalJson(barrier.action_snapshot) !== canonicalJson(persistedAction) ||
    canonicalJson(barrier.outcome_snapshot) !== canonicalJson(persistedOutcome) ||
    canonicalJson(plan.steps) !== canonicalJson(persistedSteps)
  ) {
    throw new Error('Existing execution admission conflicts with requested authority.');
  }
}

export interface AdmitMemoryExecutionInput extends AdmitExecutionInput {
  opportunityId: string;
  report: MemoryActionLoopReport;
  preEffectOutcome: {
    explanation: string;
    confidence: number;
  };
  preEffectExplanation: Omit<CreateExplanationInput, 'decisionId'>;
}

export interface AdmitApprovalExecutionInput extends AdmitExecutionInput {
  approvalId: string;
  memoryOpportunityId?: string;
  sourceRiskSnapshot: Record<string, unknown>;
  preEffectExplanation: Omit<CreateExplanationInput, 'decisionId'>;
}

export interface ExecutionAdmission {
  barrier: ExecutionAdmissionRow;
  plan: ExecutionPlanRow;
  created: boolean;
}

export interface ObserveExecutionInput {
  id: string;
  userId: string;
  status: Exclude<ExecutionAdmissionStatus, 'in_progress'>;
  result: Record<string, unknown>;
}

/**
 * Durable one-shot authority for adapters that cannot deduplicate a replay.
 * The local running plan and its user-visible linkage land in the same
 * transaction as admission, before an adapter can be invoked.
 */
export const executionAdmissionRepository = {
  async findByScope(
    userId: string,
    scope: ExecutionAdmissionScope,
    idempotencyKey: string,
    authority: AdmitExecutionInput,
  ): Promise<ExecutionAdmission | null> {
    assertSnapshotAuthority(authority);
    const barrierResult = await query<ExecutionAdmissionRow>(
      `SELECT b.* FROM execution_admission_barriers b
       JOIN users u ON u.id = b.user_id
       WHERE b.user_id = $1 AND b.scope = $2 AND b.idempotency_key = $3`,
      [userId, scope, idempotencyKey],
    );
    const barrier = barrierResult.rows[0];
    if (!barrier) return null;
    const planResult = await query<ExecutionPlanRow>(
      `SELECT * FROM execution_plans WHERE id = $1`,
      [barrier.execution_plan_id],
    );
    const plan = planResult.rows[0];
    if (!plan) throw new Error('Execution admission plan is missing.');
    assertExactAdmission(barrier, plan, authority);
    return { barrier, plan, created: false };
  },

  async admitMemoryExecution(input: AdmitMemoryExecutionInput): Promise<ExecutionAdmission> {
    assertSnapshotAuthority(input);
    if (input.policySnapshot['allowed'] !== true ||
        input.policySnapshot['requiresApproval'] !== false) {
      throw new Error('Memory execution policy does not authorize automatic dispatch.');
    }
    return withTransaction(async (client) => {
      const owner = await client.query(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [input.userId],
      );
      if (!owner.rows[0]) throw new Error('Memory execution owner is unavailable.');

      const existing = await client.query<ExecutionAdmissionRow>(
        `SELECT b.* FROM execution_admission_barriers b
         WHERE b.user_id = $1 AND b.scope = 'memory' AND b.idempotency_key = $2
         FOR UPDATE`,
        [input.userId, input.opportunityId],
      );
      if (existing.rows[0]) {
        const plan = await client.query<ExecutionPlanRow>(
          `SELECT * FROM execution_plans WHERE id = $1`,
          [existing.rows[0].execution_plan_id],
        );
        if (!plan.rows[0]) throw new Error('Execution admission plan is missing.');
        assertExactAdmission(existing.rows[0], plan.rows[0], input);
        return { barrier: existing.rows[0], plan: plan.rows[0], created: false };
      }

      const authority = await client.query<{ id: string; risk_assessment: Record<string, unknown> }>(
        `SELECT m.id, a.risk_assessment
         FROM memory_action_opportunities m
         JOIN decisions d ON d.id = $3 AND d.user_id = $1
         JOIN candidate_actions a ON a.id = $4 AND a.decision_id = d.id
         WHERE m.id = $2 AND m.user_id = $1
           AND m.status IN ('suggested', 'blocked_by_policy', 'learning_needed', 'execution_failed')
         FOR UPDATE OF m, d, a`,
        [input.userId, input.opportunityId, input.decisionId, input.actionId],
      );
      if (!authority.rows[0]) throw new Error('Memory execution admission authority is unavailable.');
      if (canonicalJson(authority.rows[0].risk_assessment) !== canonicalJson(input.riskSnapshot)) {
        throw new Error('Memory execution risk snapshot conflicts with persisted authority.');
      }

      const outcomeResult = await client.query<{ id: string }>(
        `INSERT INTO decision_outcomes
           (decision_id, selected_action_id, auto_executed, requires_approval,
            escalation_reason, explanation, confidence)
         VALUES ($1, $2, true, false, NULL, $3, $4)
         RETURNING id`,
        [input.decisionId, input.actionId, input.preEffectOutcome.explanation,
          input.preEffectOutcome.confidence],
      );
      const outcomeId = outcomeResult.rows[0]?.id;
      if (!outcomeId) throw new Error('Memory pre-effect outcome could not be persisted.');

      const explanation = input.preEffectExplanation;
      const explanationResult = await client.query<{ id: string }>(
        `INSERT INTO explanation_records (
           decision_id, what_happened, evidence_used, preferences_invoked,
           confidence_reasoning, action_rationale, escalation_rationale,
           correction_guidance, capability_provenance_node_id
         ) VALUES ($1, $2, $3::JSONB, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [input.decisionId, explanation.whatHappened,
          JSON.stringify(explanation.evidenceUsed ?? []), explanation.preferencesInvoked ?? [],
          explanation.confidenceReasoning, explanation.actionRationale,
          explanation.escalationRationale ?? null, explanation.correctionGuidance,
          explanation.capabilityProvenanceNodeId ?? null],
      );
      const explanationId = explanationResult.rows[0]?.id;
      if (!explanationId) throw new Error('Memory pre-effect explanation could not be persisted.');

      const planResult = await client.query<ExecutionPlanRow>(
        `INSERT INTO execution_plans (decision_id, action_id, status, steps)
         VALUES ($1, $2, 'running', $3::JSONB)
         RETURNING *`,
        [input.decisionId, input.actionId, JSON.stringify(input.steps)],
      );
      const plan = planResult.rows[0];
      if (!plan) throw new Error('Memory execution plan could not be admitted.');

      const barrierResult = await client.query<ExecutionAdmissionRow>(
        `INSERT INTO execution_admission_barriers
           (user_id, scope, idempotency_key, decision_id, action_id, execution_plan_id,
            outcome_id, explanation_id, risk_snapshot, policy_snapshot,
            action_snapshot, outcome_snapshot)
         VALUES ($1, 'memory', $2, $3, $4, $5, $6, $7, $8::JSONB, $9::JSONB,
                 $10::JSONB, $11::JSONB)
         RETURNING *`,
        [input.userId, input.opportunityId, input.decisionId, input.actionId, plan.id,
          outcomeId, explanationId, JSON.stringify(input.riskSnapshot),
          JSON.stringify(input.policySnapshot), JSON.stringify(input.actionSnapshot),
          JSON.stringify(input.outcomeSnapshot)],
      );
      const barrier = barrierResult.rows[0];
      if (!barrier) throw new Error('Memory execution barrier could not be admitted.');

      const frozen = await client.query(
        `UPDATE memory_action_opportunities
         SET status = 'execution_ambiguous', last_report = $3::JSONB,
             decision_id = $4, execution_plan_id = $5,
             route_reason = 'Execution admitted; automatic replay is disabled.',
             next_step = $6, updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING id`,
        [input.opportunityId, input.userId, JSON.stringify(input.report),
          input.decisionId, plan.id, input.report.nextStep],
      );
      if (!frozen.rows[0]) throw new Error('Memory opportunity could not be frozen before execution.');
      return { barrier, plan, created: true };
    });
  },

  async admitApprovalExecution(input: AdmitApprovalExecutionInput): Promise<ExecutionAdmission> {
    assertSnapshotAuthority(input);
    if (input.policySnapshot['allowed'] !== true) {
      throw new Error('Approval execution policy does not authorize dispatch.');
    }
    return withTransaction(async (client) => {
      const owner = await client.query(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [input.userId],
      );
      if (!owner.rows[0]) throw new Error('Approval execution owner is unavailable.');

      const scope: ExecutionAdmissionScope = input.memoryOpportunityId ? 'memory' : 'approval';
      const idempotencyKey = input.memoryOpportunityId ?? input.approvalId;
      const existing = await client.query<ExecutionAdmissionRow>(
        `SELECT b.* FROM execution_admission_barriers b
         WHERE b.user_id = $1 AND b.scope = $2 AND b.idempotency_key = $3
         FOR UPDATE`,
        [input.userId, scope, idempotencyKey],
      );
      if (existing.rows[0]) {
        const plan = await client.query<ExecutionPlanRow>(
          `SELECT * FROM execution_plans WHERE id = $1`,
          [existing.rows[0].execution_plan_id],
        );
        if (!plan.rows[0]) throw new Error('Execution admission plan is missing.');
        assertExactAdmission(existing.rows[0], plan.rows[0], input);
        return { barrier: existing.rows[0], plan: plan.rows[0], created: false };
      }

      const authority = await client.query<{
        id: string;
        outcome_id: string;
        risk_assessment: Record<string, unknown>;
      }>(
        `SELECT ar.id, o.id AS outcome_id, a.risk_assessment
         FROM approval_requests ar
         JOIN decisions d ON d.id = ar.decision_id AND d.user_id = $1
         JOIN candidate_actions a ON a.id = $4 AND a.decision_id = d.id
         JOIN decision_outcomes o ON o.decision_id = d.id AND o.selected_action_id = a.id
         WHERE ar.id = $2 AND ar.user_id = $1 AND ar.decision_id = $3
           AND ar.status = 'approved' AND ar.candidate_action->>'id' = $4::STRING
           AND ($5::UUID IS NULL OR EXISTS (
             SELECT 1 FROM memory_action_opportunities m
             WHERE m.id = $5 AND m.user_id = $1 AND m.decision_id = $3
               AND m.status = 'queued_approval'
           ))
         FOR UPDATE OF ar, d, a, o`,
        [input.userId, input.approvalId, input.decisionId, input.actionId,
          input.memoryOpportunityId ?? null],
      );
      if (!authority.rows[0]) throw new Error('Approval execution admission authority is unavailable.');
      if (canonicalJson(authority.rows[0].risk_assessment) !== canonicalJson(input.sourceRiskSnapshot)) {
        throw new Error('Approval source risk snapshot conflicts with persisted authority.');
      }
      const explanation = input.preEffectExplanation;
      const explanationResult = await client.query<{ id: string }>(
        `INSERT INTO explanation_records (
           decision_id, what_happened, evidence_used, preferences_invoked,
           confidence_reasoning, action_rationale, escalation_rationale,
           correction_guidance, capability_provenance_node_id
         ) VALUES ($1, $2, $3::JSONB, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [input.decisionId, explanation.whatHappened,
          JSON.stringify(explanation.evidenceUsed ?? []), explanation.preferencesInvoked ?? [],
          explanation.confidenceReasoning, explanation.actionRationale,
          explanation.escalationRationale ?? null, explanation.correctionGuidance,
          explanation.capabilityProvenanceNodeId ?? null],
      );
      const explanationId = explanationResult.rows[0]?.id;
      if (!explanationId) throw new Error('Approval pre-effect explanation could not be persisted.');

      const planResult = await client.query<ExecutionPlanRow>(
        `INSERT INTO execution_plans (decision_id, action_id, status, steps)
         VALUES ($1, $2, 'running', $3::JSONB)
         RETURNING *`,
        [input.decisionId, input.actionId, JSON.stringify(input.steps)],
      );
      const plan = planResult.rows[0];
      if (!plan) throw new Error('Approval execution plan could not be admitted.');

      const barrierResult = await client.query<ExecutionAdmissionRow>(
         `INSERT INTO execution_admission_barriers
           (user_id, scope, idempotency_key, decision_id, action_id, execution_plan_id,
            outcome_id, explanation_id, risk_snapshot, policy_snapshot,
            action_snapshot, outcome_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10::JSONB,
                 $11::JSONB, $12::JSONB)
         RETURNING *`,
        [input.userId, scope, idempotencyKey, input.decisionId, input.actionId, plan.id,
          authority.rows[0].outcome_id, explanationId,
          JSON.stringify(input.riskSnapshot), JSON.stringify(input.policySnapshot),
          JSON.stringify(input.actionSnapshot), JSON.stringify(input.outcomeSnapshot)],
      );
      const barrier = barrierResult.rows[0];
      if (!barrier) throw new Error('Approval execution barrier could not be admitted.');

      const linked = await client.query(
        `UPDATE decision_outcomes
         SET execution_plan_id = $1
         WHERE decision_id = $2 AND selected_action_id = $3
         RETURNING id`,
        [plan.id, input.decisionId, input.actionId],
      );
      if (!linked.rows[0]) throw new Error('Approval execution plan could not be linked.');
      if (input.memoryOpportunityId) {
        const frozen = await client.query(
          `UPDATE memory_action_opportunities
           SET status = 'execution_ambiguous', execution_plan_id = $3,
               route_reason = 'Approved execution admitted; automatic replay is disabled.',
               next_step = 'Reconcile the admitted execution before considering another attempt.',
               updated_at = now()
           WHERE id = $1 AND user_id = $2 AND status = 'queued_approval'
           RETURNING id`,
          [input.memoryOpportunityId, input.userId, plan.id],
        );
        if (!frozen.rows[0]) throw new Error('Approved memory opportunity could not be frozen.');
      }
      return { barrier, plan, created: true };
    });
  },

  /** Re-check exact owner and graph authority immediately before adapter dispatch. */
  async isDispatchable(
    admission: ExecutionAdmission,
    authority: AdmitExecutionInput,
  ): Promise<boolean> {
    assertSnapshotAuthority(authority);
    assertExactAdmission(admission.barrier, admission.plan, authority);
    const result = await query(
      `SELECT b.id
       FROM execution_admission_barriers b
       JOIN users u ON u.id = b.user_id
       JOIN decisions d ON d.id = b.decision_id AND d.user_id = b.user_id
       JOIN candidate_actions a ON a.id = b.action_id AND a.decision_id = b.decision_id
       JOIN execution_plans ep ON ep.id = b.execution_plan_id
         AND ep.decision_id = b.decision_id AND ep.action_id = b.action_id
       JOIN decision_outcomes o ON o.id = b.outcome_id
         AND o.decision_id = b.decision_id AND o.selected_action_id = b.action_id
       JOIN explanation_records er ON er.id = b.explanation_id
         AND er.decision_id = b.decision_id
       WHERE b.id = $1 AND b.user_id = $2 AND b.scope = $3
         AND b.idempotency_key = $4 AND b.status = 'in_progress'
         AND b.execution_plan_id = $5 AND ep.status = 'running'
         AND b.risk_snapshot = $6::JSONB
         AND b.policy_snapshot = $7::JSONB
         AND b.action_snapshot = $8::JSONB
         AND b.outcome_snapshot = $9::JSONB
         AND ep.steps = $10::JSONB
         AND (u.autonomy_settings->>'paused') IS DISTINCT FROM 'true'`,
      [admission.barrier.id, admission.barrier.user_id, admission.barrier.scope,
        admission.barrier.idempotency_key, admission.plan.id,
        JSON.stringify(authority.riskSnapshot), JSON.stringify(authority.policySnapshot),
        JSON.stringify(authority.actionSnapshot), JSON.stringify(authority.outcomeSnapshot),
        JSON.stringify(authority.steps)],
    );
    return !!result.rows[0];
  },

  async observeTerminal(input: ObserveExecutionInput): Promise<ExecutionAdmissionRow> {
    if (typeof input.result['planId'] !== 'string' ||
        ((input.status === 'completed' || input.status === 'failed') &&
          input.result['status'] !== input.status)) {
      throw new Error('Execution observation does not match its terminal status.');
    }
    const observed = normalizeExecutionRecord(input.result);
    const result = await query<ExecutionAdmissionRow>(
      `UPDATE execution_admission_barriers
       SET status = $3, observed_result = $4::JSONB, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'in_progress'
         AND execution_plan_id::STRING = ($4::JSONB)->>'planId'
       RETURNING *`,
      [input.id, input.userId, input.status, JSON.stringify(observed)],
    );
    if (result.rows[0]) return result.rows[0];

    const existing = await query<ExecutionAdmissionRow>(
      `SELECT * FROM execution_admission_barriers WHERE id = $1 AND user_id = $2`,
      [input.id, input.userId],
    );
    const row = existing.rows[0];
    if (row?.status === input.status &&
        canonicalJson(row.observed_result) === canonicalJson(observed)) {
      return row;
    }
    throw new Error('Execution admission terminal state conflicts with its observed result.');
  },
};
