import {
  snapshotInferenceReceiptExport,
  verifyInferenceReceiptExport,
  type AttestationVerificationInput,
  type InferenceReceiptExportV1,
} from '@skytwin/shared-types';
import { query, withTransaction } from '../connection.js';
import type { InferenceReceiptRow, PaginationOptions } from '../types.js';

export interface CreateInferenceReceiptInput {
  bundle: InferenceReceiptExportV1;
  /** Trusted recorder keys come from server configuration, never the bundle. */
  trustedRecorderKeys: ReadonlyMap<string, string>;
  trustedProviderKeys?: ReadonlyMap<string, string>;
  verifyAttestation?: (input: AttestationVerificationInput) => boolean;
}

export interface InferenceReceiptCompletionLinkage {
  decisionId: string;
  explanationId: string;
}

/** All methods require the authenticated owner; ownership is checked by join. */
export const inferenceReceiptRepository = {
  async createForUser(userId: string, input: CreateInferenceReceiptInput): Promise<InferenceReceiptRow | null> {
    const bundle = snapshotInferenceReceiptExport(input.bundle);
    if (!bundle) return null;
    const receipt = bundle.receipt;
    const verification = verifyInferenceReceiptExport(bundle, {
      trustedRecorderKeys: input.trustedRecorderKeys,
      trustedProviderKeys: input.trustedProviderKeys,
      verifyAttestation: input.verifyAttestation,
    });
    if (!verification.valid || !verification.trusted) return null;
    const result = await query<InferenceReceiptRow>(
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
    return result.rows[0] ?? null;
  },

  /** Persist all calls linked to one explanation atomically, or persist none. */
  async createManyForUser(
    userId: string,
    inputs: CreateInferenceReceiptInput[],
    completion: InferenceReceiptCompletionLinkage,
  ): Promise<InferenceReceiptRow[] | null> {
    const verified = inputs.map((input) => ({
      input,
      result: verifyInferenceReceiptExport(input.bundle, {
        trustedRecorderKeys: input.trustedRecorderKeys,
        trustedProviderKeys: input.trustedProviderKeys,
        verifyAttestation: input.verifyAttestation,
      }),
    }));
    if (verified.some(({ result }) => !result.valid || !result.trusted)) return null;
    if (verified.some(({ input }) => {
      const receipt = input.bundle.receipt;
      return receipt.userId !== userId
        || receipt.decisionId !== completion.decisionId
        || receipt.explanationId !== completion.explanationId;
    })) return null;

    return withTransaction(async (client) => {
      const rows: InferenceReceiptRow[] = [];
      for (const { input } of verified) {
        const receipt = input.bundle.receipt;
        const result = await client.query<InferenceReceiptRow>(
          `INSERT INTO inference_receipts (id, version, decision_id, explanation_id, status, receipt, trusted)
           SELECT $2, $3, d.id, er.id, $6, $7::JSONB, true
           FROM decisions d
           JOIN explanation_records er ON er.decision_id = d.id
           WHERE d.user_id = $1 AND d.id = $4 AND er.id = $5
             AND $1 = $8 AND $4 = $9 AND $5 = $10
           RETURNING *`,
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
         ON CONFLICT (decision_id) DO UPDATE SET
           explanation_id = EXCLUDED.explanation_id,
           completed_at = now()
         RETURNING decision_id`,
        [userId, completion.decisionId, completion.explanationId],
      );
      if (!completed.rows[0]) throw new Error('Inference receipt completion was not persisted');
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
