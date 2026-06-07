import { query } from '../connection.js';
import type {
  DecisionRow,
  CandidateActionRow,
  DecisionOutcomeRow,
  ExplanationRecordRow,
  FeedbackEventRow,
  UserQueryOptions,
  DecisionWithContext,
} from '../types.js';

/**
 * Input for creating a decision record.
 */
export interface CreateDecisionInput {
  id?: string;
  userId: string;
  situationType: string;
  rawEvent: Record<string, unknown>;
  interpretedSituation: Record<string, unknown>;
  domain: string;
  urgency?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for adding a candidate action to a decision.
 */
export interface CreateCandidateActionInput {
  id?: string;
  decisionId: string;
  actionType: string;
  description: string;
  parameters?: Record<string, unknown>;
  predictedUserPreference: string;
  riskAssessment: Record<string, unknown>;
  reversible?: boolean;
  estimatedCost?: number | null;
}

/**
 * Input for recording a decision outcome.
 */
export interface CreateOutcomeInput {
  decisionId: string;
  selectedActionId?: string | null;
  autoExecuted?: boolean;
  requiresApproval?: boolean;
  escalationReason?: string | null;
  explanation: string;
  confidence: number;
}

/**
 * Repository for decision-related operations.
 */
export const decisionRepository = {
  /**
   * Create a new decision record, or return the existing one for a
   * re-ingestion of the same `(user_id, signal_id)`.
   *
   * Pulls `signal_id` out of the rawEvent JSON when present, then pre-checks
   * for an existing `(user_id, signal_id)` row. A duplicate ingest (worker
   * dedupe miss, manual replay, etc.) returns the existing decision rather
   * than racing on the partial unique index from migration 023 — the index
   * is the defense-in-depth backstop, this lookup is the friendly path.
   *
   * Returns `{ row, created }` where `created` is true only when this call
   * inserted the row. Callers gate downstream side-effects on `created` so
   * a re-ingestion doesn't re-fire SSE emits, re-execute the action, etc.
   * (Pattern mirrors `approvalRepository.create`.)
   */
  async create(input: CreateDecisionInput): Promise<{ row: DecisionRow; created: boolean }> {
    const rawEvent = input.rawEvent as Record<string, unknown> | undefined;
    const signalId =
      rawEvent && typeof rawEvent['signalId'] === 'string'
        ? (rawEvent['signalId'] as string)
        : null;

    if (signalId) {
      const existing = await query<DecisionRow>(
        'SELECT * FROM decisions WHERE user_id = $1 AND signal_id = $2 LIMIT 1',
        [input.userId, signalId],
      );
      if (existing.rows[0]) {
        return { row: existing.rows[0], created: false };
      }
    }

    try {
      if (input.id) {
        // Explicit ID path: lets in-memory decisions keep their UUID through
        // to persistence so candidate_actions FK references resolve.
        const result = await query<DecisionRow>(
          `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, signal_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            input.id,
            input.userId,
            input.situationType,
            JSON.stringify(input.rawEvent),
            JSON.stringify(input.interpretedSituation),
            input.domain,
            input.urgency ?? 'normal',
            JSON.stringify(input.metadata ?? {}),
            signalId,
          ],
        );
        return { row: result.rows[0]!, created: true };
      }
      const result = await query<DecisionRow>(
        `INSERT INTO decisions (user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, signal_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.userId,
          input.situationType,
          JSON.stringify(input.rawEvent),
          JSON.stringify(input.interpretedSituation),
          input.domain,
          input.urgency ?? 'normal',
          JSON.stringify(input.metadata ?? {}),
          signalId,
        ],
      );
      return { row: result.rows[0]!, created: true };
    } catch (err) {
      // Race-loser path: the SELECT pre-check above and the INSERT below
      // are not in a single transaction, so two concurrent ingestions of
      // the same (user_id, signal_id) can both pass the pre-check and
      // both attempt INSERT. The partial unique index from migration 023
      // is the backstop — the loser surfaces SQLSTATE 23505. Catch it,
      // re-fetch the row the winner just wrote, and return `created:
      // false` so the caller treats the loser as a re-ingestion (no SSE
      // emit, no duplicate side-effects). Only safe to swallow when
      // signalId is set — that's the only case where a 23505 here can
      // mean "the other request beat us." Without a signalId there is no
      // unique constraint that could legitimately reject the insert.
      const code = (err as { code?: unknown } | null)?.code;
      if (signalId && code === '23505') {
        const recovered = await query<DecisionRow>(
          'SELECT * FROM decisions WHERE user_id = $1 AND signal_id = $2 LIMIT 1',
          [input.userId, signalId],
        );
        if (recovered.rows[0]) {
          return { row: recovered.rows[0], created: false };
        }
      }
      throw err;
    }
  },

  /**
   * Find a decision by its UUID.
   */
  async findById(id: string): Promise<DecisionRow | null> {
    const result = await query<DecisionRow>(
      'SELECT * FROM decisions WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Find decisions for a user with filtering and pagination.
   */
  async findByUser(
    userId: string,
    opts: UserQueryOptions = {},
  ): Promise<DecisionRow[]> {
    const conditions: string[] = ['user_id = $1'];
    const values: unknown[] = [userId];
    let paramIndex = 2;

    if (opts.domain) {
      conditions.push(`domain = $${paramIndex}`);
      values.push(opts.domain);
      paramIndex++;
    }

    if (opts.from) {
      conditions.push(`created_at >= $${paramIndex}`);
      values.push(opts.from);
      paramIndex++;
    }

    if (opts.to) {
      conditions.push(`created_at <= $${paramIndex}`);
      values.push(opts.to);
      paramIndex++;
    }

    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    values.push(limit);
    const limitParam = paramIndex;
    paramIndex++;

    values.push(offset);
    const offsetParam = paramIndex;

    const result = await query<DecisionRow>(
      `SELECT * FROM decisions
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      values,
    );
    return result.rows;
  },

  /**
   * Add a candidate action to a decision.
   */
  async addCandidateAction(
    input: CreateCandidateActionInput,
  ): Promise<CandidateActionRow> {
    if (input.id) {
      const result = await query<CandidateActionRow>(
        `INSERT INTO candidate_actions (
          id, decision_id, action_type, description, parameters,
          predicted_user_preference, risk_assessment, reversible, estimated_cost
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          input.id,
          input.decisionId,
          input.actionType,
          input.description,
          JSON.stringify(input.parameters ?? {}),
          input.predictedUserPreference,
          JSON.stringify(input.riskAssessment),
          input.reversible ?? true,
          input.estimatedCost ?? null,
        ],
      );
      return result.rows[0]!;
    }
    const result = await query<CandidateActionRow>(
      `INSERT INTO candidate_actions (
        decision_id, action_type, description, parameters,
        predicted_user_preference, risk_assessment, reversible, estimated_cost
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        input.decisionId,
        input.actionType,
        input.description,
        JSON.stringify(input.parameters ?? {}),
        input.predictedUserPreference,
        JSON.stringify(input.riskAssessment),
        input.reversible ?? true,
        input.estimatedCost ?? null,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Get all candidate actions for a decision.
   */
  async getCandidateActions(
    decisionId: string,
  ): Promise<CandidateActionRow[]> {
    const result = await query<CandidateActionRow>(
      'SELECT * FROM candidate_actions WHERE decision_id = $1 ORDER BY created_at',
      [decisionId],
    );
    return result.rows;
  },

  /**
   * Batch-fetch decisions by an array of IDs.
   */
  async findByIds(ids: string[]): Promise<DecisionRow[]> {
    if (ids.length === 0) return [];
    const result = await query<DecisionRow>(
      'SELECT * FROM decisions WHERE id = ANY($1)',
      [ids],
    );
    return result.rows;
  },

  /**
   * Batch-fetch candidate actions for multiple decisions.
   */
  async getCandidateActionsForDecisions(
    decisionIds: string[],
  ): Promise<CandidateActionRow[]> {
    if (decisionIds.length === 0) return [];
    const result = await query<CandidateActionRow>(
      'SELECT * FROM candidate_actions WHERE decision_id = ANY($1) ORDER BY created_at',
      [decisionIds],
    );
    return result.rows;
  },

  /**
   * Record the outcome of a decision.
   */
  async recordOutcome(
    input: CreateOutcomeInput,
  ): Promise<DecisionOutcomeRow> {
    // Idempotent on decision_id — re-ingesting the same signal (worker
    // dedup miss, manual replay) re-runs the engine, and the new outcome
    // replaces the prior one. The unique constraint at the DB layer keeps
    // "one outcome per decision" but doesn't pin which outcome.
    const result = await query<DecisionOutcomeRow>(
      `INSERT INTO decision_outcomes (
        decision_id, selected_action_id, auto_executed,
        requires_approval, escalation_reason, explanation, confidence
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (decision_id) DO UPDATE SET
        selected_action_id = EXCLUDED.selected_action_id,
        auto_executed = EXCLUDED.auto_executed,
        requires_approval = EXCLUDED.requires_approval,
        escalation_reason = EXCLUDED.escalation_reason,
        explanation = EXCLUDED.explanation,
        confidence = EXCLUDED.confidence
      RETURNING *`,
      [
        input.decisionId,
        input.selectedActionId ?? null,
        input.autoExecuted ?? false,
        input.requiresApproval ?? false,
        input.escalationReason ?? null,
        input.explanation,
        input.confidence,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Get the outcome for a decision.
   */
  async getOutcome(decisionId: string): Promise<DecisionOutcomeRow | null> {
    const result = await query<DecisionOutcomeRow>(
      'SELECT * FROM decision_outcomes WHERE decision_id = $1',
      [decisionId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Batch-fetch outcomes for multiple decisions in a single query.
   */
  async getOutcomesForDecisions(decisionIds: string[]): Promise<Pick<DecisionOutcomeRow, 'decision_id' | 'auto_executed' | 'requires_approval'>[]> {
    if (decisionIds.length === 0) return [];
    const result = await query<Pick<DecisionOutcomeRow, 'decision_id' | 'auto_executed' | 'requires_approval'>>(
      'SELECT decision_id, auto_executed, requires_approval FROM decision_outcomes WHERE decision_id = ANY($1)',
      [decisionIds],
    );
    return result.rows;
  },

  /**
   * Get the full context for a decision, including candidate actions,
   * outcome, explanation, and feedback.
   */
  async getDecisionWithContext(
    id: string,
  ): Promise<DecisionWithContext | null> {
    const decision = await this.findById(id);
    if (!decision) return null;

    const [candidateActions, outcome, explanationResult, feedbackResult] =
      await Promise.all([
        query<CandidateActionRow>(
          'SELECT * FROM candidate_actions WHERE decision_id = $1 ORDER BY created_at',
          [id],
        ),
        query<DecisionOutcomeRow>(
          'SELECT * FROM decision_outcomes WHERE decision_id = $1',
          [id],
        ),
        query<ExplanationRecordRow>(
          'SELECT * FROM explanation_records WHERE decision_id = $1',
          [id],
        ),
        query<FeedbackEventRow>(
          'SELECT * FROM feedback_events WHERE decision_id = $1 ORDER BY created_at',
          [id],
        ),
      ]);

    return {
      decision,
      candidateActions: candidateActions.rows,
      outcome: outcome.rows[0] ?? null,
      explanation: explanationResult.rows[0] ?? null,
      feedback: feedbackResult.rows,
    };
  },
};
