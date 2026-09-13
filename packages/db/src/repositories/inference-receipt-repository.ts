import {
  snapshotInferenceReceiptExport,
  verifyInferenceReceiptExport,
  type AttestationVerificationInput,
  type DecisionOutcome,
  type ExplanationRecord,
  type InferenceReceiptExportV1,
} from '@skytwin/shared-types';
import { query, withTransaction } from '../connection.js';
import type { CandidateActionRow, InferenceReceiptRow, PaginationOptions } from '../types.js';

export interface CreateInferenceReceiptInput {
  /** Free-form receipt strings must contain identifiers/reasons only, never source content or secrets. */
  bundle: InferenceReceiptExportV1;
  /** Trusted recorder keys come from server configuration, never the bundle. */
  trustedRecorderKeys: ReadonlyMap<string, string>;
  trustedProviderKeys?: ReadonlyMap<string, string>;
  verifyAttestation?: (input: AttestationVerificationInput) => boolean;
}

export interface InferenceReceiptCompletionLinkage {
  decisionId: string;
  explanationId: string;
  continuationKind: 'auto_execute' | 'approval' | 'non_effect';
  confirmationLevel: 'single' | 'dual' | null;
  continuation: DecisionContinuation;
}

export interface DecisionContinuation {
  outcome: DecisionOutcome;
  explanation: ExplanationRecord;
}

export interface InferenceReceiptCaptureResult {
  receipts: InferenceReceiptRow[];
  continuation: DecisionContinuation;
}

export type DecisionEffectState =
  | 'non_effect'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'restored_non_replay';

export interface DecisionContinuationBundle {
  receiptCaptureComplete: boolean;
  receiptExplanationId: string | null;
  continuationKind: 'auto_execute' | 'approval' | 'non_effect';
  confirmationLevel: 'single' | 'dual' | null;
  effectState: DecisionEffectState;
  sourceEffectState: DecisionEffectState | null;
  sourceExecutionStatus: 'completed' | 'failed' | 'ambiguous' | null;
  sourceExecutionPlanId: string | null;
  continuation: DecisionContinuation | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function snapshotContinuation(value: unknown): DecisionContinuation | null {
  try {
    const snapshot = JSON.parse(JSON.stringify(value)) as DecisionContinuation;
    const outcome = snapshot.outcome;
    const explanation = snapshot.explanation;
    if (!outcome || !explanation || typeof outcome.id !== 'string' ||
        typeof outcome.decisionId !== 'string' || typeof outcome.autoExecute !== 'boolean' ||
        typeof outcome.requiresApproval !== 'boolean' || typeof outcome.reasoning !== 'string' ||
        !Array.isArray(outcome.allCandidates) || typeof explanation.id !== 'string' ||
        typeof explanation.decisionId !== 'string' || typeof explanation.summary !== 'string') {
      return null;
    }
    if (outcome.selectedAction && (
      typeof outcome.selectedAction.id !== 'string' ||
      outcome.selectedAction.decisionId !== outcome.decisionId ||
      typeof outcome.selectedAction.actionType !== 'string' ||
      typeof outcome.selectedAction.description !== 'string' ||
      typeof outcome.selectedAction.parameters !== 'object' ||
      outcome.selectedAction.parameters === null
    )) return null;
    if (outcome.riskAssessment && (
      typeof outcome.riskAssessment.actionId !== 'string' ||
      outcome.riskAssessment.actionId !== outcome.selectedAction?.id
    )) return null;
    return snapshot;
  } catch {
    return null;
  }
}

/** All methods require the authenticated owner; ownership is checked by join. */
export const inferenceReceiptRepository = {
  /** Persist all calls linked to one explanation atomically, or persist none. */
  async createManyForUser(
    userId: string,
    inputs: CreateInferenceReceiptInput[],
    completion: InferenceReceiptCompletionLinkage,
  ): Promise<InferenceReceiptCaptureResult | null> {
    const continuation = snapshotContinuation(completion.continuation);
    if (!continuation) return null;
    const finalization: InferenceReceiptCompletionLinkage = {
      decisionId: completion.decisionId,
      explanationId: completion.explanationId,
      continuationKind: completion.continuationKind,
      confirmationLevel: completion.confirmationLevel,
      continuation,
    };
    const expectedOutcome = continuation.outcome;
    const expectedExplanation = continuation.explanation;
    const expectedSelectedAction = expectedOutcome.selectedAction;
    const expectedKind = expectedOutcome.requiresApproval && expectedSelectedAction
      ? 'approval'
      : expectedOutcome.autoExecute && expectedSelectedAction ? 'auto_execute' : 'non_effect';
    if (!['auto_execute', 'approval', 'non_effect'].includes(finalization.continuationKind) ||
        (finalization.continuationKind === 'approval'
          ? finalization.confirmationLevel !== 'single' && finalization.confirmationLevel !== 'dual'
          : finalization.confirmationLevel !== null) ||
        typeof finalization.decisionId !== 'string' || typeof finalization.explanationId !== 'string' ||
        expectedOutcome.decisionId !== finalization.decisionId ||
        expectedExplanation.decisionId !== finalization.decisionId ||
        expectedExplanation.id !== finalization.explanationId ||
        expectedKind !== finalization.continuationKind ||
        (expectedOutcome.autoExecute && expectedOutcome.requiresApproval)) {
      return null;
    }
    const verified: Array<{
      bundle: InferenceReceiptExportV1;
      result: ReturnType<typeof verifyInferenceReceiptExport>;
    }> = [];
    for (const input of inputs) {
      const bundle = snapshotInferenceReceiptExport(input.bundle);
      if (!bundle) return null;
      verified.push({
        bundle,
        result: verifyInferenceReceiptExport(bundle, {
          trustedRecorderKeys: input.trustedRecorderKeys,
          trustedProviderKeys: input.trustedProviderKeys,
          verifyAttestation: input.verifyAttestation,
        }),
      });
    }
    if (verified.some(({ result }) => !result.valid || !result.trusted)) return null;
    if (verified.some(({ bundle }) => {
      const receipt = bundle.receipt;
      return receipt.userId !== userId
        || receipt.decisionId !== finalization.decisionId
        || receipt.explanationId !== finalization.explanationId;
    })) return null;

    return withTransaction(async (client) => {
      // The decision row is the per-capture serialization point. Without
      // this lock, two first attempts can both insert different receipt IDs
      // before racing on the completion marker, leaving one logical capture
      // with evidence from two executions.
      const authority = await client.query<{
        id: string;
        outcome_id: string;
        selected_action_id: string | null;
        auto_executed: boolean;
        requires_approval: boolean;
        explanation: string;
        explanation_id: string;
        what_happened: string;
      }>(
        `SELECT d.id, o.id AS outcome_id, o.selected_action_id,
           o.auto_executed, o.requires_approval,
           COALESCE(o.escalation_reason, o.explanation) AS explanation,
           er.id AS explanation_id, er.what_happened
           FROM decisions d
           JOIN decision_outcomes o ON o.decision_id = d.id
           JOIN explanation_records er ON er.decision_id = d.id
          WHERE d.user_id = $1 AND d.id = $2 AND er.id = $3
          FOR UPDATE OF d, o, er`,
        [userId, finalization.decisionId, finalization.explanationId],
      );
      const persistedAuthority = authority.rows[0];
      if (!persistedAuthority ||
          persistedAuthority.selected_action_id !== (expectedSelectedAction?.id ?? null) ||
          persistedAuthority.auto_executed !== expectedOutcome.autoExecute ||
          persistedAuthority.requires_approval !== expectedOutcome.requiresApproval ||
          persistedAuthority.explanation !== expectedOutcome.reasoning ||
          persistedAuthority.explanation_id !== expectedExplanation.id ||
          persistedAuthority.what_happened !== expectedExplanation.summary) {
        throw new Error('Inference receipt continuation does not match persisted authority');
      }
      // recordOutcome owns the durable UUID; the engine's in-memory outcome
      // ID is not persisted by the adapter. The continuation must carry the
      // exact row identity selected under lock.
      expectedOutcome.id = persistedAuthority.outcome_id;

      let selectedActionRow: CandidateActionRow | null = null;
      if (expectedSelectedAction) {
        const selected = await client.query<CandidateActionRow>(
          `SELECT * FROM candidate_actions
           WHERE decision_id = $1 AND id = $2
           FOR UPDATE`,
          [finalization.decisionId, expectedSelectedAction.id],
        );
        selectedActionRow = selected.rows[0] ?? null;
        const expectedParameters = { ...expectedSelectedAction.parameters, domain: expectedSelectedAction.domain };
        if (!selectedActionRow || selectedActionRow.action_type !== expectedSelectedAction.actionType ||
            selectedActionRow.description !== expectedSelectedAction.description ||
            selectedActionRow.reversible !== expectedSelectedAction.reversible ||
            (selectedActionRow.estimated_cost ?? 0) !== expectedSelectedAction.estimatedCostCents ||
            selectedActionRow.predicted_user_preference !== expectedSelectedAction.confidence ||
            canonicalJson(selectedActionRow.parameters) !== canonicalJson(expectedParameters) ||
            canonicalJson(selectedActionRow.risk_assessment) !== canonicalJson(expectedOutcome.riskAssessment)) {
          throw new Error('Inference receipt continuation action does not match persisted authority');
        }
      } else if (expectedOutcome.riskAssessment !== null) {
        throw new Error('Inference receipt continuation has risk without a selected action');
      }

      const existingCompletion = await client.query(
        `SELECT explanation_id FROM inference_receipt_completions WHERE decision_id = $1`,
        [finalization.decisionId],
      );
      if (existingCompletion.rows[0]) {
        throw new Error('Inference receipt capture was already finalized');
      }

      const rows: InferenceReceiptRow[] = [];
      for (const { bundle } of verified) {
        const receipt = bundle.receipt;
        const result = await client.query<InferenceReceiptRow>(
          `INSERT INTO inference_receipts (id, version, decision_id, explanation_id, status, receipt, trusted)
           SELECT $2, $3, d.id, er.id, $6, $7::JSONB, true
           FROM decisions d
           JOIN explanation_records er ON er.decision_id = d.id
           WHERE d.user_id = $1 AND d.id = $4 AND er.id = $5
             AND $1 = $8 AND $4 = $9 AND $5 = $10
           RETURNING id, version::INT4 AS version, decision_id, explanation_id,
             status, receipt, trusted, created_at`,
          [userId, receipt.id, receipt.version, receipt.decisionId, receipt.explanationId,
            receipt.status, JSON.stringify(receipt), receipt.userId, receipt.decisionId, receipt.explanationId],
        );
        if (!result.rows[0]) throw new Error('Inference receipt linkage was not persisted');
        rows.push(result.rows[0]);
      }
      const completed = await client.query(
        `INSERT INTO inference_receipt_completions (decision_id, explanation_id)
         SELECT d.id, er.id
         FROM decisions d
         JOIN explanation_records er ON er.decision_id = d.id
         WHERE d.user_id = $1 AND d.id = $2 AND er.id = $3
         ON CONFLICT (decision_id) DO NOTHING
         RETURNING decision_id`,
        [userId, finalization.decisionId, finalization.explanationId],
      );
      if (!completed.rows[0]) throw new Error('Inference receipt completion was not persisted');

      const guarded = await client.query(
        `INSERT INTO decision_ingest_guards (
           decision_id, receipt_explanation_id, outcome_id, selected_action_id,
           outcome_auto_execute, outcome_requires_approval, risk_snapshot,
           policy_snapshot, continuation_snapshot, continuation_kind,
           confirmation_level, effect_state
         )
         SELECT d.id, er.id, o.id, o.selected_action_id,
           o.auto_executed, o.requires_approval, $5::JSONB, $6::JSONB,
           $7::JSONB, $8, $9, $10
         FROM decisions d
         JOIN decision_outcomes o ON o.decision_id = d.id
         JOIN explanation_records er ON er.decision_id = d.id
         WHERE d.user_id = $1 AND d.id = $2 AND er.id = $3 AND o.id = $4
         ON CONFLICT (decision_id) DO NOTHING
         RETURNING continuation_snapshot`,
        [userId, finalization.decisionId, finalization.explanationId, persistedAuthority.outcome_id,
          JSON.stringify(selectedActionRow?.risk_assessment ?? null),
          JSON.stringify(expectedOutcome.policyVerdicts ?? {}), JSON.stringify(continuation),
          finalization.continuationKind, finalization.confirmationLevel,
          finalization.continuationKind === 'auto_execute' ? 'ready' : 'non_effect'],
      );
      const persistedContinuation = snapshotContinuation(guarded.rows[0]?.continuation_snapshot);
      if (!persistedContinuation) throw new Error('Decision ingest guard was not persisted');
      return { receipts: rows, continuation: persistedContinuation };
    });
  },

  async isCompleteForDecision(userId: string, decisionId: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM inference_receipt_completions irc
       JOIN decisions d ON d.id = irc.decision_id
       WHERE d.user_id = $1 AND irc.decision_id = $2`,
      [userId, decisionId],
    );
    return !!result.rows[0];
  },

  async getContinuationForDecision(userId: string, decisionId: string): Promise<DecisionContinuationBundle | null> {
    const result = await query<{
      receipt_capture_complete: boolean;
      receipt_explanation_id: string | null;
      continuation_kind: 'auto_execute' | 'approval' | 'non_effect';
      confirmation_level: 'single' | 'dual' | null;
      effect_state: DecisionEffectState;
      source_effect_state: DecisionEffectState | null;
      source_execution_status: 'completed' | 'failed' | 'ambiguous' | null;
      source_execution_plan_id: string | null;
      outcome_id: string | null;
      selected_action_id: string | null;
      outcome_auto_execute: boolean | null;
      outcome_requires_approval: boolean | null;
      risk_snapshot: unknown;
      policy_snapshot: unknown;
      continuation_snapshot: unknown;
    }>(
      `SELECT (irc.decision_id IS NOT NULL) AS receipt_capture_complete,
         g.receipt_explanation_id, g.continuation_kind, g.confirmation_level,
         g.effect_state, g.source_effect_state, g.source_execution_status,
         g.source_execution_plan_id, g.outcome_id, g.selected_action_id,
         g.outcome_auto_execute, g.outcome_requires_approval,
         g.risk_snapshot, g.policy_snapshot, g.continuation_snapshot
       FROM decision_ingest_guards g
       JOIN decisions d ON d.id = g.decision_id
       LEFT JOIN inference_receipt_completions irc ON irc.decision_id = g.decision_id
       WHERE d.user_id = $1 AND g.decision_id = $2`,
      [userId, decisionId],
    );
    const row = result.rows[0];
    if (!row) {
      // A legacy completion without its guard is never permission to repeat
      // an effect. Migration 076 backfills these; rolling upgrades fail safe.
      const legacy = await query<{ explanation_id: string }>(
        `SELECT irc.explanation_id FROM inference_receipt_completions irc
         JOIN decisions d ON d.id = irc.decision_id
         WHERE d.user_id = $1 AND irc.decision_id = $2`,
        [userId, decisionId],
      );
      if (!legacy.rows[0]) return null;
      return {
        receiptCaptureComplete: true,
        receiptExplanationId: legacy.rows[0].explanation_id,
        continuationKind: 'auto_execute',
        confirmationLevel: null,
        effectState: 'restored_non_replay',
        sourceEffectState: null,
        sourceExecutionStatus: 'ambiguous',
        sourceExecutionPlanId: null,
        continuation: null,
      };
    }
    // Restores intentionally carry no live continuation snapshot: a backup is
    // historical evidence, never a newly minted execution queue. Preserve its
    // validated source classification for display/audit while withholding all
    // continuation authority.
    if (row.effect_state === 'restored_non_replay') {
      return {
        receiptCaptureComplete: row.receipt_capture_complete,
        receiptExplanationId: row.receipt_explanation_id,
        continuationKind: row.continuation_kind,
        confirmationLevel: row.confirmation_level,
        effectState: 'restored_non_replay',
        sourceEffectState: row.source_effect_state,
        sourceExecutionStatus: row.source_execution_status,
        sourceExecutionPlanId: row.source_execution_plan_id,
        continuation: null,
      };
    }
    const continuation = snapshotContinuation(row.continuation_snapshot);
    if (!continuation ||
      continuation.outcome.id !== row.outcome_id ||
      continuation.outcome.decisionId !== decisionId ||
      continuation.explanation.id !== row.receipt_explanation_id ||
      continuation.explanation.decisionId !== decisionId ||
      (continuation.outcome.selectedAction?.id ?? null) !== row.selected_action_id ||
      continuation.outcome.autoExecute !== row.outcome_auto_execute ||
      continuation.outcome.requiresApproval !== row.outcome_requires_approval ||
      canonicalJson(continuation.outcome.riskAssessment) !== canonicalJson(row.risk_snapshot) ||
      canonicalJson(continuation.outcome.policyVerdicts ?? {}) !== canonicalJson(row.policy_snapshot)) {
      // A damaged or manually altered snapshot is never continuation
      // authority. The guard state still suppresses any replay.
      return {
        receiptCaptureComplete: row.receipt_capture_complete,
        receiptExplanationId: row.receipt_explanation_id,
        continuationKind: row.continuation_kind,
        confirmationLevel: row.confirmation_level,
        effectState: 'restored_non_replay',
        sourceEffectState: row.effect_state,
        sourceExecutionStatus: 'ambiguous',
        sourceExecutionPlanId: row.source_execution_plan_id,
        continuation: null,
      };
    }
    return {
      receiptCaptureComplete: row.receipt_capture_complete,
      receiptExplanationId: row.receipt_explanation_id,
      continuationKind: row.continuation_kind,
      confirmationLevel: row.confirmation_level,
      effectState: row.effect_state,
      sourceEffectState: row.source_effect_state,
      sourceExecutionStatus: row.source_execution_status,
      sourceExecutionPlanId: row.source_execution_plan_id,
      continuation,
    };
  },

  async claimExecutionForDecision(
    userId: string,
    decisionId: string,
    authority: { outcomeId: string; explanationId: string; selectedActionId: string },
  ): Promise<boolean> {
    const result = await query(
      `UPDATE decision_ingest_guards AS g
       SET effect_state = 'running', updated_at = now()
       FROM decisions d
       WHERE d.id = g.decision_id AND d.user_id = $1
         AND g.decision_id = $2 AND g.effect_state = 'ready'
         AND g.continuation_kind = 'auto_execute'
         AND g.outcome_auto_execute IS TRUE
         AND g.outcome_requires_approval IS FALSE
         AND g.selected_action_id IS NOT NULL
         AND g.continuation_snapshot IS NOT NULL
         AND g.outcome_id = $3
         AND g.receipt_explanation_id = $4
         AND g.selected_action_id = $5
       RETURNING g.decision_id`,
      [userId, decisionId, authority.outcomeId, authority.explanationId, authority.selectedActionId],
    );
    return !!result.rows[0];
  },

  async markExecutionTerminalForDecision(
    userId: string,
    decisionId: string,
    status: 'completed' | 'failed',
    planId: string,
  ): Promise<boolean> {
    const result = await query(
      `UPDATE decision_ingest_guards AS g
       SET effect_state = $3, source_execution_status = $3,
         source_execution_plan_id = $4, updated_at = now()
       FROM decisions d, execution_plans ep
       WHERE d.id = g.decision_id AND d.user_id = $1
         AND g.decision_id = $2 AND g.effect_state = 'running'
         AND ep.id = $4 AND ep.decision_id = g.decision_id
         AND ep.action_id = g.selected_action_id
       RETURNING g.decision_id`,
      [userId, decisionId, status, planId],
    );
    return !!result.rows[0];
  },

  async markNonEffectForDecision(userId: string, decisionId: string): Promise<boolean> {
    const result = await query(
      `UPDATE decision_ingest_guards AS g
       SET effect_state = 'non_effect', updated_at = now()
       FROM decisions d
       WHERE d.id = g.decision_id AND d.user_id = $1
         AND g.decision_id = $2 AND g.effect_state = 'ready'
       RETURNING g.decision_id`,
      [userId, decisionId],
    );
    return !!result.rows[0];
  },

  async findByIdForUser(userId: string, id: string): Promise<InferenceReceiptRow | null> {
    const result = await query<InferenceReceiptRow>(
      `SELECT ir.id, ir.version::INT4 AS version, ir.decision_id, ir.explanation_id,
         ir.status, ir.receipt, ir.trusted, ir.created_at FROM inference_receipts ir
       JOIN decisions d ON d.id = ir.decision_id
       WHERE d.user_id = $1 AND ir.id = $2`, [userId, id],
    );
    return result.rows[0] ?? null;
  },

  async findByDecisionForUser(userId: string, decisionId: string): Promise<InferenceReceiptRow | null> {
    const result = await query<InferenceReceiptRow>(
      `SELECT ir.id, ir.version::INT4 AS version, ir.decision_id, ir.explanation_id,
         ir.status, ir.receipt, ir.trusted, ir.created_at FROM inference_receipts ir
       JOIN decisions d ON d.id = ir.decision_id
       WHERE d.user_id = $1 AND ir.decision_id = $2
       ORDER BY ir.created_at DESC LIMIT 1`, [userId, decisionId],
    );
    return result.rows[0] ?? null;
  },

  async listForUser(userId: string, opts: PaginationOptions = {}): Promise<InferenceReceiptRow[]> {
    const result = await query<InferenceReceiptRow>(
      `SELECT ir.id, ir.version::INT4 AS version, ir.decision_id, ir.explanation_id,
         ir.status, ir.receipt, ir.trusted, ir.created_at FROM inference_receipts ir
       JOIN decisions d ON d.id = ir.decision_id
       WHERE d.user_id = $1 ORDER BY ir.created_at DESC LIMIT $2 OFFSET $3`,
      [userId, opts.limit ?? 50, opts.offset ?? 0],
    );
    return result.rows;
  },

  async deleteForUser(userId: string, id: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM inference_receipts WHERE id IN (
         SELECT ir.id FROM inference_receipts ir JOIN decisions d ON d.id = ir.decision_id
         WHERE d.user_id = $1 AND ir.id = $2
       )`, [userId, id],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async deleteByDecisionForUser(userId: string, decisionId: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM inference_receipts WHERE id IN (
         SELECT ir.id FROM inference_receipts ir JOIN decisions d ON d.id = ir.decision_id
         WHERE d.user_id = $1 AND ir.decision_id = $2
       )`, [userId, decisionId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
