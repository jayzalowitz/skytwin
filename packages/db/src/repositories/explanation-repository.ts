import { query } from '../connection.js';
import type { ExplanationRecordRow, PaginationOptions } from '../types.js';

/**
 * Input for creating an explanation record.
 */
export interface CreateExplanationInput {
  decisionId: string;
  whatHappened: string;
  evidenceUsed?: unknown[];
  preferencesInvoked?: string[];
  confidenceReasoning: string;
  actionRationale: string;
  escalationRationale?: string | null;
  correctionGuidance: string;
}

/**
 * Repository for explanation / audit record operations.
 */
export const explanationRepository = {
  /**
   * Create a new explanation record for a decision.
   */
  async create(input: CreateExplanationInput): Promise<ExplanationRecordRow> {
    const result = await query<ExplanationRecordRow>(
      `INSERT INTO explanation_records (
        decision_id, what_happened, evidence_used, preferences_invoked,
        confidence_reasoning, action_rationale, escalation_rationale, correction_guidance
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        input.decisionId,
        input.whatHappened,
        JSON.stringify(input.evidenceUsed ?? []),
        input.preferencesInvoked ?? [],
        input.confidenceReasoning,
        input.actionRationale,
        input.escalationRationale ?? null,
        input.correctionGuidance,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Find the explanation record for a specific decision.
   */
  async findByDecision(
    decisionId: string,
  ): Promise<ExplanationRecordRow | null> {
    const result = await query<ExplanationRecordRow>(
      'SELECT * FROM explanation_records WHERE decision_id = $1',
      [decisionId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Find explanation records for a user's decisions, with pagination.
   */
  async findByUser(
    userId: string,
    opts: PaginationOptions = {},
  ): Promise<ExplanationRecordRow[]> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const result = await query<ExplanationRecordRow>(
      `SELECT er.*
       FROM explanation_records er
       JOIN decisions d ON er.decision_id = d.id
       WHERE d.user_id = $1
       ORDER BY er.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows;
  },
};
