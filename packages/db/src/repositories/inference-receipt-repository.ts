import {
  normalizeAdapterOutput,
  normalizeExecutionError,
  normalizeExecutionPlanSteps,
  normalizeMemoryActionAdapterName,
  snapshotInferenceReceiptExport,
  verifyInferenceReceiptExport,
  type AttestationVerificationInput,
  type DecisionOutcome,
  type ExplanationRecord,
  type InferenceReceiptExportV1,
} from '@skytwin/shared-types';
import { query, withTransaction } from '../connection.js';
import type {
  ApprovalRequestRow,
  CandidateActionRow,
  ExecutionPlanRow,
  InferenceReceiptRow,
  PaginationOptions,
} from '../types.js';

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

export interface ClaimedExecutionPlan extends ExecutionPlanRow {
  dispatchAuthorityUpdatedAt: Date;
}

export interface PreparedDecisionDispatch {
  executionPlanId: string;
  adapterName: string;
  riskSnapshot: Record<string, unknown>;
}

export interface EscalateDecisionToApprovalInput {
  userId: string;
  decisionId: string;
  continuation: DecisionContinuation;
  candidateAction: Record<string, unknown>;
  reason: string;
  urgency: string;
  confirmationLevel: 'single' | 'dual';
  expiresAt?: Date;
  dispatch?: Omit<PreparedDecisionDispatch, 'executionPlanId'> & {
    policySnapshot: Record<string, unknown>;
  };
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
        typeof explanation.decisionId !== 'string' || typeof explanation.userId !== 'string' ||
        typeof explanation.summary !== 'string' || !Array.isArray(explanation.evidenceUsed) ||
        !Array.isArray(explanation.preferencesInvoked) ||
        typeof explanation.confidenceReasoning !== 'string' ||
        typeof explanation.actionRationale !== 'string' ||
        (explanation.escalationRationale !== undefined &&
          typeof explanation.escalationRationale !== 'string') ||
        typeof explanation.correctionGuidance !== 'string' ||
        typeof explanation.riskTier !== 'string' ||
        typeof explanation.overallConfidence !== 'string' ||
        (explanation.capabilityProvenanceNodeId !== undefined &&
          typeof explanation.capabilityProvenanceNodeId !== 'string') ||
        instant(explanation.createdAt) === null) {
      return null;
    }
    if (explanation.evidenceUsed.some((evidence) =>
      !evidence || typeof evidence.evidenceId !== 'string' ||
      typeof evidence.source !== 'string' || typeof evidence.summary !== 'string' ||
      typeof evidence.relevance !== 'string')) return null;
    if (explanation.preferencesInvoked.some((preference) =>
      !preference || typeof preference.preferenceId !== 'string' ||
      typeof preference.domain !== 'string' || typeof preference.key !== 'string' ||
      typeof preference.confidence !== 'string' || typeof preference.howUsed !== 'string')) return null;
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

function instant(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sameUuid(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
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
    const selectedPolicyVerdict = expectedSelectedAction
      ? expectedOutcome.policyVerdicts?.[expectedSelectedAction.id]
      : undefined;
    const expectedKind = expectedOutcome.requiresApproval && expectedSelectedAction
      ? 'approval'
      : expectedOutcome.autoExecute && expectedSelectedAction ? 'auto_execute' : 'non_effect';
    if (!['auto_execute', 'approval', 'non_effect'].includes(finalization.continuationKind) ||
        (finalization.continuationKind === 'approval'
          ? finalization.confirmationLevel !== 'single' && finalization.confirmationLevel !== 'dual'
          : finalization.confirmationLevel !== null) ||
        typeof finalization.decisionId !== 'string' || typeof finalization.explanationId !== 'string' ||
        !sameUuid(expectedOutcome.decisionId, finalization.decisionId) ||
        !sameUuid(expectedExplanation.decisionId, finalization.decisionId) ||
        !sameUuid(expectedExplanation.id, finalization.explanationId) ||
        expectedKind !== finalization.continuationKind ||
        (expectedOutcome.autoExecute && expectedOutcome.requiresApproval) ||
        (finalization.continuationKind === 'auto_execute' && selectedPolicyVerdict !== 'allowed') ||
        (finalization.continuationKind === 'approval' && selectedPolicyVerdict !== 'requires-approval')) {
      return null;
    }
    const expectedEvidence: unknown[] = expectedExplanation.evidenceUsed.map((evidence) => ({
      evidenceId: evidence.evidenceId,
      source: evidence.source,
      summary: evidence.summary,
      relevance: evidence.relevance,
    }));
    expectedEvidence.push({
      __adapter_meta: true,
      riskTier: expectedExplanation.riskTier,
      overallConfidence: expectedExplanation.overallConfidence,
      userId: expectedExplanation.userId,
    });
    const expectedPreferences = expectedExplanation.preferencesInvoked.map((preference) => JSON.stringify({
      preferenceId: preference.preferenceId,
      domain: preference.domain,
      key: preference.key,
      confidence: preference.confidence,
      howUsed: preference.howUsed,
    }));
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
    const receiptIds = new Set<string>();
    if (verified.some(({ bundle }) => {
      const receipt = bundle.receipt;
      const normalizedId = receipt.id.toLowerCase();
      if (receiptIds.has(normalizedId)) return true;
      receiptIds.add(normalizedId);
      return !sameUuid(receipt.userId, userId)
        || !sameUuid(receipt.decisionId, finalization.decisionId)
        || !sameUuid(receipt.explanationId, finalization.explanationId);
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
        evidence_used: unknown[];
        preferences_invoked: string[];
        confidence_reasoning: string;
        action_rationale: string;
        escalation_rationale: string | null;
        correction_guidance: string;
        capability_provenance_node_id: string | null;
        explanation_created_at: Date;
      }>(
        `SELECT d.id, o.id AS outcome_id, o.selected_action_id,
           o.auto_executed, o.requires_approval,
           COALESCE(o.escalation_reason, o.explanation) AS explanation,
           er.id AS explanation_id, er.what_happened, er.evidence_used,
           er.preferences_invoked, er.confidence_reasoning, er.action_rationale,
           er.escalation_rationale, er.correction_guidance,
           er.capability_provenance_node_id,
           er.created_at AS explanation_created_at
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
          persistedAuthority.what_happened !== expectedExplanation.summary ||
          canonicalJson(persistedAuthority.evidence_used) !== canonicalJson(expectedEvidence) ||
          canonicalJson(persistedAuthority.preferences_invoked) !== canonicalJson(expectedPreferences) ||
          persistedAuthority.confidence_reasoning !== expectedExplanation.confidenceReasoning ||
          persistedAuthority.action_rationale !== expectedExplanation.actionRationale ||
          persistedAuthority.escalation_rationale !== (expectedExplanation.escalationRationale ?? null) ||
          persistedAuthority.correction_guidance !== expectedExplanation.correctionGuidance ||
          persistedAuthority.capability_provenance_node_id !==
            (expectedExplanation.capabilityProvenanceNodeId ?? null) ||
          instant(persistedAuthority.explanation_created_at) !== instant(expectedExplanation.createdAt)) {
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
      for (const [captureOrdinal, { bundle }] of verified.entries()) {
        const receipt = bundle.receipt;
        const result = await client.query<InferenceReceiptRow>(
          `INSERT INTO inference_receipts (
             id, version, decision_id, explanation_id, capture_ordinal, status, receipt, trusted
           )
           SELECT $2, $3, d.id, er.id, $6, $7, $8::JSONB, true
           FROM decisions d
           JOIN explanation_records er ON er.decision_id = d.id
           WHERE d.user_id = $1 AND d.id = $4 AND er.id = $5
             AND $1::UUID = $9::UUID AND $4::UUID = $10::UUID AND $5::UUID = $11::UUID
           RETURNING id, version::INT4 AS version, decision_id, explanation_id,
             capture_ordinal::INT4 AS capture_ordinal, status, receipt, trusted, created_at`,
          [userId, receipt.id, receipt.version, receipt.decisionId, receipt.explanationId,
            captureOrdinal, receipt.status, JSON.stringify(receipt), receipt.userId,
            receipt.decisionId, receipt.explanationId],
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
    suppliedContinuation: DecisionContinuation,
    steps: unknown[],
    refreshedPolicySnapshot: Record<string, unknown>,
    dispatch: PreparedDecisionDispatch,
  ): Promise<ClaimedExecutionPlan | null> {
    const continuation = snapshotContinuation(suppliedContinuation);
    const outcome = continuation?.outcome;
    const explanation = continuation?.explanation;
    const selectedAction = outcome?.selectedAction;
    if (!continuation || !outcome || !explanation || !selectedAction ||
        outcome.decisionId !== decisionId || explanation.decisionId !== decisionId ||
        !outcome.autoExecute || outcome.requiresApproval ||
        outcome.policyVerdicts?.[selectedAction.id] !== 'allowed' ||
        refreshedPolicySnapshot['allowed'] !== true ||
        refreshedPolicySnapshot['requiresApproval'] !== false ||
        !dispatch || dispatch.riskSnapshot['actionId'] !== selectedAction.id ||
        normalizeMemoryActionAdapterName(dispatch.adapterName) !== dispatch.adapterName) {
      return null;
    }

    return withTransaction(async (client) => {
      // Owner-first locking gives account purge and effect admission one
      // serializable order. Once purge owns this row, no new effect can claim.
      const owner = await client.query(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (!owner.rows[0]) return null;

      const locked = await client.query(
        `SELECT g.decision_id
         FROM decision_ingest_guards g
         JOIN decisions d ON d.id = g.decision_id
         JOIN decision_outcomes o ON o.id = g.outcome_id AND o.decision_id = g.decision_id
         WHERE d.user_id = $1 AND g.decision_id = $2 AND g.effect_state = 'ready'
           AND g.continuation_kind = 'auto_execute'
           AND g.outcome_auto_execute IS TRUE AND g.outcome_requires_approval IS FALSE
           AND g.outcome_id = $3 AND g.receipt_explanation_id = $4
           AND g.selected_action_id = $5 AND o.selected_action_id = $5
           AND o.auto_executed IS TRUE AND o.requires_approval IS FALSE
           AND COALESCE(o.escalation_reason, o.explanation) = $6
           AND g.continuation_snapshot = $7::JSONB
           AND g.risk_snapshot = $8::JSONB
           AND g.policy_snapshot = $9::JSONB
         FOR UPDATE OF g, d, o`,
        [userId, decisionId, outcome.id, explanation.id, selectedAction.id,
          outcome.reasoning, JSON.stringify(continuation), JSON.stringify(outcome.riskAssessment),
          JSON.stringify(outcome.policyVerdicts ?? {})],
      );
      if (!locked.rows[0]) return null;

      const inserted = await client.query<ExecutionPlanRow>(
        `INSERT INTO execution_plans (id, decision_id, action_id, status, steps, evidence_schema_version)
         VALUES ($1, $2, $3, 'running', $4::JSONB, 1)
         RETURNING *`,
        [dispatch.executionPlanId, decisionId, selectedAction.id,
          JSON.stringify(normalizeExecutionPlanSteps(steps))],
      );
      const plan = inserted.rows[0];
      if (!plan) throw new Error('Execution plan could not be persisted with its claim');

      const linked = await client.query(
        `UPDATE decision_outcomes
         SET execution_plan_id = $1
         WHERE id = $2 AND decision_id = $3 AND selected_action_id = $4
           AND auto_executed IS TRUE AND requires_approval IS FALSE
           AND COALESCE(escalation_reason, explanation) = $5
         RETURNING id`,
        [plan.id, outcome.id, decisionId, selectedAction.id, outcome.reasoning],
      );
      if (!linked.rows[0]) throw new Error('Execution plan could not bind to its outcome authority');

      const claimed = await client.query<{ decision_id: string; updated_at: Date }>(
        `UPDATE decision_ingest_guards
         SET effect_state = 'running', source_execution_plan_id = $2,
             dispatch_policy_snapshot = $6::JSONB,
             dispatch_adapter_name = $7,
             dispatch_risk_snapshot = $8::JSONB,
             updated_at = now()
         WHERE decision_id = $1 AND effect_state = 'ready' AND outcome_id = $3
           AND selected_action_id = $4 AND receipt_explanation_id = $5
         RETURNING decision_id, updated_at`,
        [decisionId, plan.id, outcome.id, selectedAction.id, explanation.id,
          JSON.stringify(refreshedPolicySnapshot), dispatch.adapterName,
          JSON.stringify(dispatch.riskSnapshot)],
      );
      if (!claimed.rows[0]) throw new Error('Execution guard claim could not bind to its plan');
      return { ...plan, dispatchAuthorityUpdatedAt: claimed.rows[0].updated_at };
    });
  },

  /**
   * Convert one exact ready receipt into a pending approval atomically. The
   * owner/guard lock order matches autonomous claim, so an execution plan and
   * an escalation approval can never both win for the same receipt.
   */
  async escalateExecutionToApproval(
    input: EscalateDecisionToApprovalInput,
  ): Promise<{ row: ApprovalRequestRow; created: boolean } | null> {
    const continuation = snapshotContinuation(input.continuation);
    const outcome = continuation?.outcome;
    const explanation = continuation?.explanation;
    const selectedAction = outcome?.selectedAction;
    const selectedParameters = selectedAction?.parameters as Record<string, unknown> | undefined;
    const {
      accessToken: _omittedAccessToken,
      rawData: _omittedRawData,
      ...visibleParameters
    } = selectedParameters ?? {};
    const expectedCandidateAction = selectedAction ? JSON.parse(JSON.stringify({
      id: selectedAction.id,
      actionType: selectedAction.actionType,
      description: selectedAction.description,
      domain: selectedAction.domain,
      parameters: visibleParameters,
      estimatedCostCents: selectedAction.estimatedCostCents,
      costZeroIntent: selectedAction.costZeroIntent,
      provenance: selectedAction.provenance,
      reversible: selectedAction.reversible,
      confidence: selectedAction.confidence,
      reasoning: selectedAction.reasoning,
    })) as Record<string, unknown> : null;
    const candidateAction = JSON.parse(JSON.stringify(input.candidateAction)) as Record<string, unknown>;
    if (!continuation || !outcome || !explanation || !selectedAction ||
        outcome.decisionId !== input.decisionId || explanation.decisionId !== input.decisionId ||
        !expectedCandidateAction || canonicalJson(candidateAction) !== canonicalJson(expectedCandidateAction) ||
        selectedAction.decisionId !== input.decisionId ||
        !outcome.autoExecute || outcome.requiresApproval ||
        (input.dispatch && (
          input.dispatch.riskSnapshot['actionId'] !== selectedAction.id ||
          normalizeMemoryActionAdapterName(input.dispatch.adapterName) !== input.dispatch.adapterName
        ))) {
      return null;
    }

    return withTransaction(async (client) => {
      const owner = await client.query(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [input.userId],
      );
      if (!owner.rows[0]) return null;

      const locked = await client.query(
        `SELECT g.decision_id
           FROM decision_ingest_guards g
           JOIN decisions d ON d.id = g.decision_id
           JOIN decision_outcomes o ON o.id = g.outcome_id AND o.decision_id = g.decision_id
          WHERE d.user_id = $1 AND g.decision_id = $2 AND g.effect_state = 'ready'
            AND g.continuation_kind = 'auto_execute'
            AND g.outcome_auto_execute IS TRUE AND g.outcome_requires_approval IS FALSE
            AND g.outcome_id = $3 AND g.receipt_explanation_id = $4
            AND g.selected_action_id = $5 AND o.selected_action_id = $5
            AND o.auto_executed IS TRUE AND o.requires_approval IS FALSE
            AND COALESCE(o.escalation_reason, o.explanation) = $6
            AND g.continuation_snapshot = $7::JSONB
            AND g.risk_snapshot IS NOT DISTINCT FROM $8::JSONB
            AND g.policy_snapshot = $9::JSONB
            AND NOT EXISTS (
              SELECT 1 FROM execution_admission_barriers b
               WHERE b.user_id = $1 AND b.decision_id = $2 AND b.action_id = $5
            )
          FOR UPDATE OF g, d, o`,
        [input.userId, input.decisionId, outcome.id, explanation.id, selectedAction.id,
          outcome.reasoning, JSON.stringify(continuation),
          JSON.stringify(outcome.riskAssessment ?? null),
          JSON.stringify(outcome.policyVerdicts ?? {})],
      );
      if (!locked.rows[0]) return null;

      const inserted = await client.query<ApprovalRequestRow>(
        `INSERT INTO approval_requests
           (user_id, decision_id, candidate_action, reason, urgency, status,
            requested_at, expires_at, confirmation_level)
         VALUES ($1, $2, $3::JSONB, $4, $5, 'pending', now(), $6, $7)
         ON CONFLICT (decision_id) DO NOTHING
         RETURNING *`,
        [input.userId, input.decisionId, JSON.stringify(candidateAction),
          input.reason, input.urgency,
          input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
          input.confirmationLevel],
      );
      let approval = inserted.rows[0];
      let created = true;
      if (!approval) {
        const existing = await client.query<ApprovalRequestRow>(
          `SELECT * FROM approval_requests
            WHERE decision_id = $1 AND user_id = $2 FOR UPDATE`,
          [input.decisionId, input.userId],
        );
        approval = existing.rows[0];
        created = false;
      }
      if (!approval || approval.status !== 'pending' ||
          canonicalJson(approval.candidate_action) !== canonicalJson(candidateAction) ||
          approval.reason !== input.reason || approval.urgency !== input.urgency ||
          approval.confirmation_level !== input.confirmationLevel) {
        throw new Error('Existing approval conflicts with receipt escalation authority.');
      }

      const consumed = await client.query(
        `UPDATE decision_ingest_guards
            SET effect_state = 'non_effect',
                continuation_kind = 'approval',
                dispatch_adapter_name = $3,
                dispatch_risk_snapshot = $4::JSONB,
                dispatch_policy_snapshot = $5::JSONB,
                confirmation_level = $6,
                updated_at = now()
          WHERE decision_id = $1 AND selected_action_id = $2
            AND effect_state = 'ready'
          RETURNING decision_id`,
        [input.decisionId, selectedAction.id,
          input.dispatch?.adapterName ?? null,
          input.dispatch ? JSON.stringify(input.dispatch.riskSnapshot) : null,
          input.dispatch ? JSON.stringify(input.dispatch.policySnapshot) : null,
          input.confirmationLevel],
      );
      if (!consumed.rows[0]) {
        throw new Error('Receipt escalation authority could not be consumed.');
      }
      return { row: approval, created };
    });
  },

  /** Exact owner/receipt/plan fence checked immediately before dispatch. */
  async isExecutionDispatchableForDecision(
    userId: string,
    decisionId: string,
    planId: string,
    suppliedContinuation: DecisionContinuation,
    steps: unknown[],
    refreshedPolicySnapshot: Record<string, unknown>,
    dispatch: PreparedDecisionDispatch,
  ): Promise<boolean> {
    const continuation = snapshotContinuation(suppliedContinuation);
    const outcome = continuation?.outcome;
    const explanation = continuation?.explanation;
    const selectedAction = outcome?.selectedAction;
    if (!continuation || !outcome || !explanation || !selectedAction ||
        outcome.decisionId !== decisionId || explanation.decisionId !== decisionId ||
        !outcome.autoExecute || outcome.requiresApproval ||
        outcome.policyVerdicts?.[selectedAction.id] !== 'allowed' ||
        refreshedPolicySnapshot['allowed'] !== true ||
        refreshedPolicySnapshot['requiresApproval'] !== false ||
        !dispatch || dispatch.executionPlanId !== planId ||
        dispatch.riskSnapshot['actionId'] !== selectedAction.id ||
        normalizeMemoryActionAdapterName(dispatch.adapterName) !== dispatch.adapterName) {
      return false;
    }
    const result = await query(
      `SELECT g.decision_id
       FROM decision_ingest_guards g
       JOIN users u ON u.id = $1
       JOIN decisions d ON d.id = g.decision_id AND d.user_id = u.id
       JOIN decision_outcomes o ON o.id = g.outcome_id
         AND o.decision_id = g.decision_id AND o.selected_action_id = g.selected_action_id
         AND o.execution_plan_id = $3
       JOIN explanation_records er ON er.id = g.receipt_explanation_id
         AND er.decision_id = g.decision_id
       JOIN execution_plans ep ON ep.id = $3 AND ep.decision_id = g.decision_id
         AND ep.action_id = g.selected_action_id AND ep.status = 'running'
       WHERE g.decision_id = $2 AND g.effect_state = 'running'
         AND g.source_execution_plan_id = $3
         AND g.dispatch_policy_snapshot = $4::JSONB
         AND g.dispatch_adapter_name = $5
         AND g.dispatch_risk_snapshot = $6::JSONB
         AND g.continuation_snapshot = $7::JSONB
         AND g.risk_snapshot = $8::JSONB
         AND g.policy_snapshot = $9::JSONB
         AND ep.steps = $10::JSONB
         AND (u.autonomy_settings->>'paused') IS DISTINCT FROM 'true'`,
      [userId, decisionId, planId, JSON.stringify(refreshedPolicySnapshot),
        dispatch.adapterName, JSON.stringify(dispatch.riskSnapshot),
        JSON.stringify(continuation), JSON.stringify(outcome.riskAssessment),
        JSON.stringify(outcome.policyVerdicts ?? {}), JSON.stringify(normalizeExecutionPlanSteps(steps))],
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
       FROM decisions d, execution_plans ep, execution_results er, decision_outcomes o
       WHERE d.id = g.decision_id AND d.user_id = $1
         AND g.decision_id = $2 AND g.effect_state = 'running'
         AND ep.id = $4 AND ep.decision_id = g.decision_id
         AND ep.action_id = g.selected_action_id
         AND g.source_execution_plan_id = ep.id
         AND o.id = g.outcome_id AND o.decision_id = g.decision_id
         AND o.selected_action_id = g.selected_action_id
         AND o.execution_plan_id = ep.id
         AND ep.status = $3 AND er.plan_id = ep.id
         AND er.success = ($3 = 'completed')
       RETURNING g.decision_id`,
      [userId, decisionId, status, planId],
    );
    return !!result.rows[0];
  },

  /** Atomically records a known no-effect failure before router invocation. */
  async markExecutionFailedBeforeDispatchForDecision(
    userId: string,
    decisionId: string,
    planId: string,
    error: string,
  ): Promise<boolean> {
    const outputs = normalizeAdapterOutput({ status: 'failed' });
    const safeError = normalizeExecutionError(error);
    return withTransaction(async (client) => {
      const authority = await client.query(
        `SELECT g.decision_id
           FROM decision_ingest_guards g
           JOIN users u ON u.id = $1
           JOIN decisions d ON d.id = g.decision_id AND d.user_id = u.id
           JOIN execution_plans ep ON ep.id = $3 AND ep.decision_id = g.decision_id
             AND ep.action_id = g.selected_action_id
           JOIN decision_outcomes o ON o.id = g.outcome_id
             AND o.decision_id = g.decision_id AND o.selected_action_id = g.selected_action_id
             AND o.execution_plan_id = ep.id
          WHERE g.decision_id = $2 AND g.effect_state = 'running'
            AND g.source_execution_plan_id = ep.id AND ep.status = 'running'
          FOR UPDATE OF g, u, d, ep, o`,
        [userId, decisionId, planId],
      );
      if (!authority.rows[0]) return false;
      await client.query(
        `INSERT INTO execution_results
           (plan_id, success, outputs, error, rollback_available, completed_at,
            evidence_schema_version)
         VALUES ($1, false, $2::JSONB, $3, false, now(), 1)
         ON CONFLICT (plan_id) DO NOTHING`,
        [planId, JSON.stringify(outputs), safeError],
      );
      const result = await client.query<{
        success: boolean;
        outputs: Record<string, unknown>;
        error: string | null;
        rollback_available: boolean;
      }>('SELECT success, outputs, error, rollback_available FROM execution_results WHERE plan_id = $1',
        [planId]);
      const persisted = result.rows[0];
      if (!persisted || persisted.success ||
          JSON.stringify(persisted.outputs) !== JSON.stringify(outputs) ||
          persisted.error !== safeError || persisted.rollback_available) {
        throw new Error('Execution result conflicts with pre-dispatch no-effect truth.');
      }
      const plan = await client.query(
        `UPDATE execution_plans SET status = 'failed', updated_at = now()
          WHERE id = $1 AND status = 'running' RETURNING id`, [planId]);
      if (!plan.rows[0]) throw new Error('Execution plan could not record pre-dispatch failure.');
      const guard = await client.query(
        `UPDATE decision_ingest_guards
            SET effect_state = 'failed', source_execution_status = 'failed', updated_at = now()
          WHERE decision_id = $1 AND effect_state = 'running'
            AND source_execution_plan_id = $2
          RETURNING decision_id`,
        [decisionId, planId],
      );
      if (!guard.rows[0]) throw new Error('Execution guard could not record pre-dispatch failure.');
      return true;
    });
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
         ir.capture_ordinal::INT4 AS capture_ordinal, ir.status, ir.receipt, ir.trusted,
         ir.created_at FROM inference_receipts ir
       JOIN decisions d ON d.id = ir.decision_id
       WHERE d.user_id = $1 AND ir.id = $2`, [userId, id],
    );
    return result.rows[0] ?? null;
  },

  async findByDecisionForUser(userId: string, decisionId: string): Promise<InferenceReceiptRow | null> {
    const result = await query<InferenceReceiptRow>(
      `SELECT ir.id, ir.version::INT4 AS version, ir.decision_id, ir.explanation_id,
         ir.capture_ordinal::INT4 AS capture_ordinal, ir.status, ir.receipt, ir.trusted,
         ir.created_at FROM inference_receipts ir
       JOIN decisions d ON d.id = ir.decision_id
       WHERE d.user_id = $1 AND ir.decision_id = $2
       ORDER BY ir.capture_ordinal DESC, ir.created_at DESC, ir.id DESC LIMIT 1`, [userId, decisionId],
    );
    return result.rows[0] ?? null;
  },

  async listForUser(userId: string, opts: PaginationOptions = {}): Promise<InferenceReceiptRow[]> {
    const result = await query<InferenceReceiptRow>(
      `SELECT ir.id, ir.version::INT4 AS version, ir.decision_id, ir.explanation_id,
         ir.capture_ordinal::INT4 AS capture_ordinal, ir.status, ir.receipt, ir.trusted,
         ir.created_at FROM inference_receipts ir
       JOIN decisions d ON d.id = ir.decision_id
       WHERE d.user_id = $1
       ORDER BY ir.created_at DESC, ir.decision_id DESC, ir.capture_ordinal DESC, ir.id DESC
       LIMIT $2 OFFSET $3`,
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
