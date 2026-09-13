import {
  normalizeExecutionObservation,
  normalizeExecutionPlanSteps,
  normalizeMemoryActionReport,
  normalizeMemoryActionAdapterName,
  normalizeMemoryActionText,
  normalizeExecutionIdentifier,
  type MemoryActionLoopReport,
} from '@skytwin/shared-types';
import { createHash } from 'node:crypto';
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
  adapter_name: string;
  risk_snapshot: Record<string, unknown>;
  policy_snapshot: Record<string, unknown>;
  action_snapshot: Record<string, unknown>;
  outcome_snapshot: Record<string, unknown>;
  status: ExecutionAdmissionStatus;
  observed_result: Record<string, unknown>;
  evidence_schema_version: number;
  created_at: Date;
  updated_at: Date;
}

function normalizeBarrierRow(row: ExecutionAdmissionRow): ExecutionAdmissionRow {
  if (row.status === 'in_progress') {
    return { ...row, observed_result: {} };
  }
  return {
    ...row,
    observed_result: normalizeExecutionObservation({
      ...row.observed_result,
      planId: row.execution_plan_id,
      status: row.status,
    }),
  };
}

interface AdmitExecutionInput {
  userId: string;
  decisionId: string;
  actionId: string;
  executionPlanId: string;
  adapterName: string;
  steps: unknown[];
  riskSnapshot: Record<string, unknown>;
  policySnapshot: Record<string, unknown>;
  actionSnapshot: Record<string, unknown>;
  outcomeSnapshot: Record<string, unknown>;
}

function assertSnapshotAuthority(input: AdmitExecutionInput): void {
  if (!input.executionPlanId || normalizeMemoryActionAdapterName(input.adapterName) !== input.adapterName ||
      input.actionSnapshot['id'] !== input.actionId ||
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
  const persistedSteps = normalizeExecutionPlanSteps(input.steps);
  const persistedRisk = JSON.parse(JSON.stringify(input.riskSnapshot)) as Record<string, unknown>;
  const persistedPolicy = JSON.parse(JSON.stringify(input.policySnapshot)) as Record<string, unknown>;
  const persistedAction = JSON.parse(JSON.stringify(input.actionSnapshot)) as Record<string, unknown>;
  const persistedOutcome = JSON.parse(JSON.stringify(input.outcomeSnapshot)) as Record<string, unknown>;
  if (
    barrier.user_id !== input.userId ||
    barrier.execution_plan_id !== plan.id ||
    barrier.decision_id !== input.decisionId ||
    barrier.action_id !== input.actionId ||
    barrier.adapter_name !== input.adapterName ||
    plan.decision_id !== input.decisionId ||
    plan.action_id !== input.actionId ||
    plan.id !== input.executionPlanId ||
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
  sourceRiskSnapshot: Record<string, unknown>;
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

export interface RecordExecutionPolicyDenialInput {
  scope: 'receipt' | 'approval';
  userId: string;
  decisionId: string;
  actionId: string;
  approvalId?: string;
  adapterName: string;
  actionSnapshot: Record<string, unknown>;
  riskSnapshot: Record<string, unknown>;
  policySnapshot: Record<string, unknown>;
  reason: string;
}

export interface ExecutionPolicyDenialRecord {
  explanationId: string;
  evidence: Record<string, unknown>;
}

export interface ReceiptPreparationDispositionInput {
  userId: string;
  decisionId: string;
  actionId: string;
  ambiguous: boolean;
  reason: string;
}

export interface ReceiptExecutionDisposition {
  explanationId: string;
  kind: 'execution_policy_denial' | 'execution_preparation_refusal' |
    'execution_preparation_ambiguous';
  status: 'blocked' | 'failed' | 'ambiguous';
  reason: string;
  summary: string;
  riskTier: string | null;
}

/**
 * Durable one-shot authority for adapters that cannot deduplicate a replay.
 * The local running plan and its user-visible linkage land in the same
 * transaction as admission, before an adapter can be invoked.
 */
export const executionAdmissionRepository = {
  /** Close a ready receipt after routing proves no request, or retain an
   * ambiguous non-replay state when preparation cannot prove that boundary. */
  async recordReceiptPreparationDisposition(
    input: ReceiptPreparationDispositionInput,
  ): Promise<ReceiptExecutionDisposition | null> {
    const reason = normalizeMemoryActionText(input.reason);
    if (!reason) throw new Error('Execution preparation disposition reason is invalid.');
    const kind = input.ambiguous
      ? 'execution_preparation_ambiguous' as const
      : 'execution_preparation_refusal' as const;
    const status = input.ambiguous ? 'ambiguous' as const : 'failed' as const;
    const summary = input.ambiguous
      ? 'SkyTwin stopped automatic replay because adapter preparation could not prove that no request started.'
      : 'SkyTwin deliberately did not execute because no prepared adapter path was available.';
    const evidence = {
      schemaVersion: 1,
      kind,
      scope: 'receipt',
      decisionId: input.decisionId,
      actionId: input.actionId,
      status,
      reason,
    };
    return withTransaction(async (client) => {
      const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
      if (!owner.rows[0]) return null;
      const guard = await client.query(
        `SELECT g.decision_id
           FROM decision_ingest_guards g
           JOIN decisions d ON d.id = g.decision_id AND d.user_id = $1
          WHERE g.decision_id = $2 AND g.selected_action_id = $3
            AND g.effect_state = 'ready' AND g.continuation_kind = 'auto_execute'
          FOR UPDATE OF g, d`,
        [input.userId, input.decisionId, input.actionId],
      );
      if (!guard.rows[0]) return null;
      const explanation = await client.query<{ id: string }>(
        `INSERT INTO explanation_records (
           decision_id, type, what_happened, evidence_used, preferences_invoked,
           confidence_reasoning, action_rationale, escalation_rationale,
           correction_guidance
         ) VALUES ($1, $2, $3, $4::JSONB, ARRAY[]::STRING[], $5, $6, $7, $8)
         RETURNING id`,
        [input.decisionId, kind, summary, JSON.stringify([evidence]),
          input.ambiguous
            ? 'The preparation boundary returned an unclassified outcome, so retry authority was consumed.'
            : 'All eligible adapters returned trusted pre-request refusals.',
          'No external action is authorized from this receipt.', reason,
          'Review adapter availability and create a new decision before trying again.'],
      );
      const explanationId = explanation.rows[0]?.id;
      if (!explanationId) throw new Error('Preparation disposition explanation was not persisted.');
      const closed = await client.query(
        `UPDATE decision_ingest_guards
            SET effect_state = $3,
                source_execution_status = $4,
                updated_at = now()
          WHERE decision_id = $1 AND selected_action_id = $2
            AND effect_state = 'ready'
          RETURNING decision_id`,
        [input.decisionId, input.actionId,
          input.ambiguous ? 'running' : 'non_effect',
          input.ambiguous ? 'ambiguous' : null],
      );
      if (!closed.rows[0]) throw new Error('Preparation disposition guard could not be consumed.');
      return { explanationId, kind, status, reason, summary, riskTier: null };
    });
  },

  /** Typed, bounded terminal projection used by lost-response receipt replay. */
  async findReceiptExecutionDisposition(
    userId: string,
    decisionId: string,
    actionId: string,
  ): Promise<ReceiptExecutionDisposition | null> {
    const result = await query<{
      id: string;
      type: ReceiptExecutionDisposition['kind'];
      what_happened: string;
      evidence_used: unknown;
    }>(
      `SELECT er.id, er.type, er.what_happened, er.evidence_used
         FROM decision_ingest_guards g
         JOIN decisions d ON d.id = g.decision_id AND d.user_id = $1
         JOIN explanation_records er ON er.decision_id = g.decision_id
        WHERE g.decision_id = $2 AND g.selected_action_id = $3
          AND g.effect_state <> 'ready'
          AND er.type IN ('execution_policy_denial', 'execution_preparation_refusal',
                          'execution_preparation_ambiguous')
          AND er.evidence_used->0->>'scope' = 'receipt'
          AND er.evidence_used->0->>'decisionId' = $2::STRING
          AND er.evidence_used->0->>'actionId' = $3::STRING
          AND er.evidence_used->0->>'kind' = er.type
        ORDER BY er.created_at DESC LIMIT 1`,
      [userId, decisionId, actionId],
    );
    const row = result.rows[0];
    const evidence = Array.isArray(row?.evidence_used) ? row.evidence_used[0] : null;
    if (!row || !evidence || typeof evidence !== 'object') return null;
    const projection = evidence as Record<string, unknown>;
    if (projection['kind'] !== row.type || projection['scope'] !== 'receipt' ||
        projection['decisionId'] !== decisionId || projection['actionId'] !== actionId) return null;
    const reason = normalizeMemoryActionText(projection['reason']);
    if (!reason) return null;
    const status = row.type === 'execution_policy_denial' ? 'blocked'
      : row.type === 'execution_preparation_ambiguous' ? 'ambiguous' : 'failed';
    const riskTier = normalizeExecutionIdentifier(projection['riskTier'], 32);
    return {
      explanationId: row.id,
      kind: row.type,
      status,
      reason,
      summary: normalizeMemoryActionText(row.what_happened) ?? 'SkyTwin did not execute this action.',
      riskTier,
    };
  },

  /** Atomically persists explanation-first truth for a proven pre-request denial. */
  async recordPolicyDenial(
    input: RecordExecutionPolicyDenialInput,
  ): Promise<ExecutionPolicyDenialRecord | null> {
    const adapterName = normalizeMemoryActionAdapterName(input.adapterName);
    const reason = normalizeMemoryActionText(input.reason);
    if (!adapterName || !reason || input.riskSnapshot['actionId'] !== input.actionId ||
        input.actionSnapshot['id'] !== input.actionId ||
        input.actionSnapshot['decisionId'] !== input.decisionId ||
        (input.scope === 'approval' && !input.approvalId)) {
      throw new Error('Execution policy denial evidence is incomplete.');
    }
    const persistedRisk = JSON.parse(JSON.stringify(input.riskSnapshot)) as Record<string, unknown>;
    const persistedPolicy = JSON.parse(JSON.stringify(input.policySnapshot)) as Record<string, unknown>;
    const actionSnapshotSha256 = createHash('sha256')
      .update(canonicalJson(input.actionSnapshot), 'utf8')
      .digest('hex');
    const riskSnapshotSha256 = createHash('sha256')
      .update(canonicalJson(persistedRisk), 'utf8')
      .digest('hex');
    const policySnapshotSha256 = createHash('sha256')
      .update(canonicalJson(persistedPolicy), 'utf8')
      .digest('hex');
    const riskTier = normalizeExecutionIdentifier(persistedRisk['overallTier'], 32) ?? 'unknown';
    const confirmationLevel = persistedPolicy['confirmationLevel'];
    const evidence: Record<string, unknown> = {
      schemaVersion: 1,
      kind: 'execution_policy_denial',
      scope: input.scope,
      decisionId: input.decisionId,
      actionId: input.actionId,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      adapterName,
      actionSnapshotSha256,
      riskSnapshotSha256,
      policySnapshotSha256,
      riskTier,
      policyAllowed: persistedPolicy['allowed'] === true,
      policyRequiresApproval: persistedPolicy['requiresApproval'] === true,
      ...(confirmationLevel === 'single' || confirmationLevel === 'dual'
        ? { confirmationLevel }
        : {}),
      reason,
    };

    return withTransaction(async (client) => {
      const graph = await client.query(
        `SELECT d.id
           FROM users u
           JOIN decisions d ON d.user_id = u.id
           JOIN candidate_actions ca ON ca.decision_id = d.id
          WHERE u.id = $1 AND d.id = $2 AND ca.id = $3
          FOR UPDATE OF u, d, ca`,
        [input.userId, input.decisionId, input.actionId],
      );
      if (!graph.rows[0]) return null;

      const existing = await client.query<{
        id: string;
        evidence_used: unknown;
      }>(
        `SELECT id, evidence_used FROM explanation_records
          WHERE decision_id = $1 AND type = 'execution_policy_denial'
          ORDER BY created_at ASC LIMIT 1`,
        [input.decisionId],
      );
      if (existing.rows[0]) {
        if (canonicalJson(existing.rows[0].evidence_used) !== canonicalJson([evidence])) {
          throw new Error('Existing execution policy denial conflicts with requested evidence.');
        }
        return { explanationId: existing.rows[0].id, evidence };
      }

      if (input.scope === 'receipt') {
        const guard = await client.query(
          `SELECT decision_id FROM decision_ingest_guards
            WHERE decision_id = $1 AND selected_action_id = $2
              AND effect_state = 'ready' FOR UPDATE`,
          [input.decisionId, input.actionId],
        );
        if (!guard.rows[0]) return null;
      } else {
        const approval = await client.query(
          `SELECT id FROM approval_requests
            WHERE id = $1 AND user_id = $2 AND decision_id = $3
              AND status = 'approved'
              AND execution_denied_at IS NULL
              AND execution_denial_explanation_id IS NULL
              AND candidate_action->>'id' = $4
            FOR UPDATE`,
          [input.approvalId, input.userId, input.decisionId, input.actionId],
        );
        if (!approval.rows[0]) return null;
        const admission = await client.query(
          `SELECT id FROM execution_admission_barriers
            WHERE user_id = $1 AND scope = 'approval' AND idempotency_key = $2`,
          [input.userId, input.approvalId],
        );
        if (admission.rows[0]) return null;
      }

      const explanation = await client.query<{ id: string }>(
        `INSERT INTO explanation_records (
           decision_id, type, what_happened, evidence_used, preferences_invoked,
           confidence_reasoning, action_rationale, escalation_rationale,
           correction_guidance
         ) VALUES (
           $1, 'execution_policy_denial',
           'SkyTwin deliberately did not execute this action after the exact prepared path was denied.',
           $2::JSONB, ARRAY[]::STRING[],
           'The current policy was evaluated against the adapter-adjusted risk before request start.',
           'No adapter request was started because current execution authority denied the exact path.',
           $3,
           'Review the current policy, prepared adapter, and risk evidence before requesting a new action.'
         ) RETURNING id`,
        [input.decisionId, JSON.stringify([evidence]), reason],
      );
      const explanationId = explanation.rows[0]?.id;
      if (!explanationId) throw new Error('Execution policy denial explanation was not persisted.');

      if (input.scope === 'receipt') {
        const closed = await client.query(
          `UPDATE decision_ingest_guards
              SET effect_state = 'non_effect',
                  dispatch_adapter_name = $3,
                  dispatch_risk_snapshot = $4::JSONB,
                  dispatch_policy_snapshot = $5::JSONB,
                  updated_at = now()
            WHERE decision_id = $1 AND selected_action_id = $2
              AND effect_state = 'ready'
            RETURNING decision_id`,
          [input.decisionId, input.actionId, adapterName,
            JSON.stringify(persistedRisk), JSON.stringify(persistedPolicy)],
        );
        if (!closed.rows[0]) throw new Error('Receipt denial guard could not be closed.');
      } else {
        const consumed = await client.query(
          `UPDATE approval_requests
              SET execution_denied_at = now(),
                  execution_denial_explanation_id = $3
            WHERE id = $1 AND user_id = $2 AND status = 'approved'
              AND execution_denied_at IS NULL
              AND execution_denial_explanation_id IS NULL
            RETURNING id`,
          [input.approvalId, input.userId, explanationId],
        );
        if (!consumed.rows[0]) {
          throw new Error('Approval denial authority could not be consumed.');
        }
      }
      return { explanationId, evidence };
    });
  },

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
    const barrier = barrierResult.rows[0] ? normalizeBarrierRow(barrierResult.rows[0]) : undefined;
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
    const report = normalizeMemoryActionReport(input.report);
    const nextStep = normalizeMemoryActionText(report.nextStep) ?? 'Reconcile execution before retrying.';
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
        const existingBarrier = normalizeBarrierRow(existing.rows[0]);
        const plan = await client.query<ExecutionPlanRow>(
          `SELECT * FROM execution_plans WHERE id = $1`,
          [existingBarrier.execution_plan_id],
        );
        if (!plan.rows[0]) throw new Error('Execution admission plan is missing.');
        assertExactAdmission(existingBarrier, plan.rows[0], input);
        return { barrier: existingBarrier, plan: plan.rows[0], created: false };
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
      if (canonicalJson(authority.rows[0].risk_assessment) !== canonicalJson(input.sourceRiskSnapshot)) {
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
        `INSERT INTO execution_plans (id, decision_id, action_id, status, steps, evidence_schema_version)
         VALUES ($1, $2, $3, 'running', $4::JSONB, 1)
         RETURNING *`,
        [input.executionPlanId, input.decisionId, input.actionId,
          JSON.stringify(normalizeExecutionPlanSteps(input.steps))],
      );
      const plan = planResult.rows[0];
      if (!plan) throw new Error('Memory execution plan could not be admitted.');

      const barrierResult = await client.query<ExecutionAdmissionRow>(
        `INSERT INTO execution_admission_barriers
           (user_id, scope, idempotency_key, decision_id, action_id, execution_plan_id,
            outcome_id, explanation_id, adapter_name, risk_snapshot, policy_snapshot,
            action_snapshot, outcome_snapshot, evidence_schema_version)
         VALUES ($1, 'memory', $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10::JSONB,
                 $11::JSONB, $12::JSONB, 1)
         RETURNING *`,
        [input.userId, input.opportunityId, input.decisionId, input.actionId, plan.id,
          outcomeId, explanationId, input.adapterName, JSON.stringify(input.riskSnapshot),
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
        [input.opportunityId, input.userId, JSON.stringify(report),
          input.decisionId, plan.id, nextStep],
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

      // Receipt claim and approval admission share owner -> receipt-guard lock
      // order. A decision whose autonomous receipt already won can never mint a
      // second plan through an approval row created by an older process.
      const receiptGuard = await client.query<{
        effect_state: string;
        selected_action_id: string | null;
        source_execution_plan_id: string | null;
        continuation_kind: string | null;
        confirmation_level: string | null;
      }>(
        `SELECT g.effect_state, g.selected_action_id, g.source_execution_plan_id,
                g.continuation_kind, g.confirmation_level
           FROM decision_ingest_guards g
           JOIN decisions d ON d.id = g.decision_id AND d.user_id = $1
          WHERE g.decision_id = $2
          FOR UPDATE OF g, d`,
        [input.userId, input.decisionId],
      );
      const receipt = receiptGuard.rows[0];
      const exactApprovalAuthority = receipt?.effect_state === 'non_effect' &&
        receipt.selected_action_id === input.actionId &&
        receipt.source_execution_plan_id === null &&
        receipt.continuation_kind === 'approval' &&
        (receipt.confirmation_level === 'single' || receipt.confirmation_level === 'dual');
      if (receipt && !exactApprovalAuthority) {
        throw new Error('Approval execution conflicts with autonomous receipt authority.');
      }

      const scope: ExecutionAdmissionScope = input.memoryOpportunityId ? 'memory' : 'approval';
      const idempotencyKey = input.memoryOpportunityId ?? input.approvalId;
      const existing = await client.query<ExecutionAdmissionRow>(
        `SELECT b.* FROM execution_admission_barriers b
         WHERE b.user_id = $1 AND b.scope = $2 AND b.idempotency_key = $3
         FOR UPDATE`,
        [input.userId, scope, idempotencyKey],
      );
      if (existing.rows[0]) {
        const existingBarrier = normalizeBarrierRow(existing.rows[0]);
        const plan = await client.query<ExecutionPlanRow>(
          `SELECT * FROM execution_plans WHERE id = $1`,
          [existingBarrier.execution_plan_id],
        );
        if (!plan.rows[0]) throw new Error('Execution admission plan is missing.');
        assertExactAdmission(existingBarrier, plan.rows[0], input);
        return { barrier: existingBarrier, plan: plan.rows[0], created: false };
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
           AND ar.execution_denied_at IS NULL
           AND ar.execution_denial_explanation_id IS NULL
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
        `INSERT INTO execution_plans (id, decision_id, action_id, status, steps, evidence_schema_version)
         VALUES ($1, $2, $3, 'running', $4::JSONB, 1)
         RETURNING *`,
        [input.executionPlanId, input.decisionId, input.actionId,
          JSON.stringify(normalizeExecutionPlanSteps(input.steps))],
      );
      const plan = planResult.rows[0];
      if (!plan) throw new Error('Approval execution plan could not be admitted.');

      const barrierResult = await client.query<ExecutionAdmissionRow>(
         `INSERT INTO execution_admission_barriers
           (user_id, scope, idempotency_key, decision_id, action_id, execution_plan_id,
            outcome_id, explanation_id, adapter_name, risk_snapshot, policy_snapshot,
            action_snapshot, outcome_snapshot, evidence_schema_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, $11::JSONB,
                 $12::JSONB, $13::JSONB, 1)
         RETURNING *`,
        [input.userId, scope, idempotencyKey, input.decisionId, input.actionId, plan.id,
          authority.rows[0].outcome_id, explanationId, input.adapterName,
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
         AND b.adapter_name = $6
         AND b.risk_snapshot = $7::JSONB
         AND b.policy_snapshot = $8::JSONB
         AND b.action_snapshot = $9::JSONB
         AND b.outcome_snapshot = $10::JSONB
         AND ep.steps = $11::JSONB
         AND (u.autonomy_settings->>'paused') IS DISTINCT FROM 'true'`,
      [admission.barrier.id, admission.barrier.user_id, admission.barrier.scope,
        admission.barrier.idempotency_key, admission.plan.id, authority.adapterName,
        JSON.stringify(authority.riskSnapshot), JSON.stringify(authority.policySnapshot),
        JSON.stringify(authority.actionSnapshot), JSON.stringify(authority.outcomeSnapshot),
        JSON.stringify(normalizeExecutionPlanSteps(authority.steps))],
    );
    return !!result.rows[0];
  },

  /**
   * Atomically close an admitted plan when the caller has not invoked the
   * router yet. This is deliberately separate from ambiguous observation:
   * callers may use it only on a control-flow branch that proves no adapter
   * or provider request could have started.
   */
  async failBeforeDispatch(input: {
    admission: ExecutionAdmission;
    userId: string;
    error: string;
  }): Promise<ExecutionAdmissionRow> {
    const observed = normalizeExecutionObservation({
      planId: input.admission.plan.id,
      status: 'failed',
      output: {},
      error: input.error,
    });
    const safeError = typeof observed['error'] === 'string' ? observed['error'] : null;
    return withTransaction(async (client) => {
      const locked = await client.query<ExecutionAdmissionRow & { plan_status: string }>(
        `SELECT b.*, ep.status AS plan_status
           FROM execution_admission_barriers b
           JOIN users u ON u.id = b.user_id
           JOIN execution_plans ep ON ep.id = b.execution_plan_id
             AND ep.decision_id = b.decision_id AND ep.action_id = b.action_id
          WHERE b.id = $1 AND b.user_id = $2 AND b.execution_plan_id = $3
          FOR UPDATE OF b, u, ep`,
        [input.admission.barrier.id, input.userId, input.admission.plan.id],
      );
      const barrier = locked.rows[0];
      if (!barrier) throw new Error('Execution admission is unavailable for pre-dispatch failure.');
      if (barrier.status === 'failed' && barrier.plan_status === 'failed' &&
          canonicalJson(barrier.observed_result) === canonicalJson(observed)) {
        return barrier;
      }
      if (barrier.status !== 'in_progress' || barrier.plan_status !== 'running') {
        throw new Error('Execution admission has already left its pre-dispatch state.');
      }

      await client.query(
        `INSERT INTO execution_results
           (plan_id, success, outputs, error, rollback_available, completed_at,
            evidence_schema_version)
         VALUES ($1, false, '{}'::JSONB, $2, false, now(), 1)
         ON CONFLICT (plan_id) DO NOTHING`,
        [input.admission.plan.id, safeError],
      );
      const result = await client.query<{
        success: boolean;
        outputs: Record<string, unknown>;
        error: string | null;
        rollback_available: boolean;
      }>('SELECT success, outputs, error, rollback_available FROM execution_results WHERE plan_id = $1',
        [input.admission.plan.id]);
      const persisted = result.rows[0];
      if (!persisted || persisted.success || canonicalJson(persisted.outputs) !== canonicalJson({}) ||
          persisted.error !== safeError || persisted.rollback_available) {
        throw new Error('Execution result conflicts with pre-dispatch no-effect truth.');
      }
      const plan = await client.query(
        `UPDATE execution_plans SET status = 'failed', updated_at = now()
          WHERE id = $1 AND status = 'running' RETURNING id`,
        [input.admission.plan.id],
      );
      if (!plan.rows[0]) throw new Error('Execution plan could not record pre-dispatch failure.');
      const terminal = await client.query<ExecutionAdmissionRow>(
        `UPDATE execution_admission_barriers
            SET status = 'failed', observed_result = $3::JSONB, updated_at = now()
          WHERE id = $1 AND user_id = $2 AND status = 'in_progress'
          RETURNING *`,
        [input.admission.barrier.id, input.userId, JSON.stringify(observed)],
      );
      if (!terminal.rows[0]) throw new Error('Execution admission could not record pre-dispatch failure.');
      return terminal.rows[0];
    });
  },

  async observeTerminal(input: ObserveExecutionInput): Promise<ExecutionAdmissionRow> {
    if (typeof input.result['planId'] !== 'string' ||
        ((input.status === 'completed' || input.status === 'failed') &&
          input.result['status'] !== input.status)) {
      throw new Error('Execution observation does not match its terminal status.');
    }
    const observed = normalizeExecutionObservation(input.result);
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
