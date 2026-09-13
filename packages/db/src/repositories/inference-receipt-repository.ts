import {
  snapshotInferenceReceiptExport,
  verifyInferenceReceiptExport,
  type AttestationVerificationInput,
  type InferenceReceiptExportV1,
} from '@skytwin/shared-types';
import { query, withTransaction } from '../connection.js';
import type { InferenceReceiptRow, PaginationOptions } from '../types.js';

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
}

export type DecisionEffectState =
  | 'non_effect'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'restored_non_replay';

export interface DecisionIngestState {
  receiptCaptureComplete: boolean;
  receiptExplanationId: string | null;
  continuationKind: 'auto_execute' | 'approval' | 'non_effect';
  confirmationLevel: 'single' | 'dual' | null;
  effectState: DecisionEffectState;
  sourceEffectState: DecisionEffectState | null;
  sourceExecutionStatus: 'completed' | 'failed' | 'ambiguous' | null;
  sourceExecutionPlanId: string | null;
}

/** All methods require the authenticated owner; ownership is checked by join. */
export const inferenceReceiptRepository = {
  /** Persist all calls linked to one explanation atomically, or persist none. */
  async createManyForUser(
    userId: string,
    inputs: CreateInferenceReceiptInput[],
    completion: InferenceReceiptCompletionLinkage,
  ): Promise<InferenceReceiptRow[] | null> {
    const finalization: InferenceReceiptCompletionLinkage = {
      decisionId: completion.decisionId,
      explanationId: completion.explanationId,
      continuationKind: completion.continuationKind,
      confirmationLevel: completion.confirmationLevel,
    };
    if (!['auto_execute', 'approval', 'non_effect'].includes(finalization.continuationKind) ||
        (finalization.continuationKind === 'approval'
          ? finalization.confirmationLevel !== 'single' && finalization.confirmationLevel !== 'dual'
          : finalization.confirmationLevel !== null) ||
        typeof finalization.decisionId !== 'string' || typeof finalization.explanationId !== 'string') {
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
      const authority = await client.query(
        `SELECT d.id
           FROM decisions d
           JOIN explanation_records er ON er.decision_id = d.id
          WHERE d.user_id = $1 AND d.id = $2 AND er.id = $3
          FOR UPDATE OF d`,
        [userId, finalization.decisionId, finalization.explanationId],
      );
      if (!authority.rows[0]) throw new Error('Inference receipt linkage was not persisted');

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
           decision_id, receipt_explanation_id, continuation_kind,
           confirmation_level, effect_state
         )
         SELECT d.id, er.id, $4, $5, $6
         FROM decisions d
         JOIN explanation_records er ON er.decision_id = d.id
         WHERE d.user_id = $1 AND d.id = $2 AND er.id = $3
         ON CONFLICT (decision_id) DO NOTHING
         RETURNING decision_id`,
        [userId, finalization.decisionId, finalization.explanationId,
          finalization.continuationKind, finalization.confirmationLevel,
          finalization.continuationKind === 'auto_execute' ? 'ready' : 'non_effect'],
      );
      if (!guarded.rows[0]) throw new Error('Decision ingest guard was not persisted');
      return rows;
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

  async getIngestStateForDecision(userId: string, decisionId: string): Promise<DecisionIngestState | null> {
    const result = await query<{
      receipt_capture_complete: boolean;
      receipt_explanation_id: string | null;
      continuation_kind: 'auto_execute' | 'approval' | 'non_effect';
      confirmation_level: 'single' | 'dual' | null;
      effect_state: DecisionEffectState;
      source_effect_state: DecisionEffectState | null;
      source_execution_status: 'completed' | 'failed' | 'ambiguous' | null;
      source_execution_plan_id: string | null;
    }>(
      `SELECT (irc.decision_id IS NOT NULL) AS receipt_capture_complete,
         g.receipt_explanation_id, g.continuation_kind, g.confirmation_level,
         g.effect_state, g.source_effect_state, g.source_execution_status,
         g.source_execution_plan_id
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
    };
  },

  async claimExecutionForDecision(userId: string, decisionId: string): Promise<boolean> {
    const result = await query(
      `UPDATE decision_ingest_guards AS g
       SET effect_state = 'running', updated_at = now()
       FROM decisions d
       WHERE d.id = g.decision_id AND d.user_id = $1
         AND g.decision_id = $2 AND g.effect_state = 'ready'
       RETURNING g.decision_id`,
      [userId, decisionId],
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
       FROM decisions d
       WHERE d.id = g.decision_id AND d.user_id = $1
         AND g.decision_id = $2 AND g.effect_state = 'running'
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
