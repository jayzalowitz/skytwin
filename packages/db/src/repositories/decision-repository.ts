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
   * Create a new decision record.
   */
  async create(input: CreateDecisionInput): Promise<DecisionRow> {
    // If an explicit ID is provided, use it (allows in-memory decisions to
    // keep their UUID through to persistence for FK consistency).
    if (input.id) {
      const result = await query<DecisionRow>(
        `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
        ],
      );
      return result.rows[0]!;
    }
    const result = await query<DecisionRow>(
      `INSERT INTO decisions (user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.userId,
        input.situationType,
        JSON.stringify(input.rawEvent),
        JSON.stringify(input.interpretedSituation),
        input.domain,
        input.urgency ?? 'normal',
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return result.rows[0]!;
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
   * Record the outcome of a decision.
   */
  async recordOutcome(
    input: CreateOutcomeInput,
  ): Promise<DecisionOutcomeRow> {
    const result = await query<DecisionOutcomeRow>(
      `INSERT INTO decision_outcomes (
        decision_id, selected_action_id, auto_executed,
        requires_approval, escalation_reason, explanation, confidence
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
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
