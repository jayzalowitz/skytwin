import { query, withTransaction } from '../connection.js';
import {
  VaultKeyProvider,
  encryptColumn,
  readColumn,
  resolveKey,
} from '../lib/vault-helper.js';
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
  async create(
    input: CreateDecisionInput,
    keyProvider: VaultKeyProvider,
  ): Promise<{ row: DecisionRow; created: boolean }> {
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
        const row = existing.rows[0];
        const keyState = resolveKey(keyProvider, input.userId);
        const rawRead = readColumn(row.raw_event_encrypted, row.raw_event, keyState.key);
        const intRead = readColumn(row.interpreted_situation_encrypted, row.interpreted_situation, keyState.key);
        if (!rawRead.success || !intRead.success) {
          const err = !rawRead.success ? rawRead.error : intRead.error;
          throw new Error(`Vault Error: ${err} for user ${input.userId}`);
        }
        return { row: { ...row, raw_event: rawRead.value, interpreted_situation: intRead.value }, created: false };
      }
    }

    try {
      const keyState = resolveKey(keyProvider, input.userId);
      let rawEventStr = JSON.stringify(input.rawEvent);
      let rawEventEncrypted = null;
      let interpretedStr = JSON.stringify(input.interpretedSituation);
      let interpretedEncrypted = null;

      if (keyState.mode === 'unlocked') {
        rawEventEncrypted = encryptColumn(rawEventStr, keyState.key);
        rawEventStr = null;
        interpretedEncrypted = encryptColumn(interpretedStr, keyState.key);
        interpretedStr = null;
      }

      if (input.id) {
        const result = await query<DecisionRow>(
          `INSERT INTO decisions (id, user_id, situation_type, raw_event, raw_event_encrypted, interpreted_situation, interpreted_situation_encrypted, domain, urgency, metadata, signal_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [
            input.id,
            input.userId,
            input.situationType,
            rawEventStr, rawEventEncrypted,
            interpretedStr, interpretedEncrypted,
            input.domain,
            input.urgency ?? 'normal',
            JSON.stringify(input.metadata ?? {}),
            signalId,
          ],
        );
        return { row: result.rows[0]!, created: true };
      }
      const result = await query<DecisionRow>(
        `INSERT INTO decisions (user_id, situation_type, raw_event, raw_event_encrypted, interpreted_situation, interpreted_situation_encrypted, domain, urgency, metadata, signal_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          input.userId,
          input.situationType,
          rawEventStr, rawEventEncrypted,
          interpretedStr, interpretedEncrypted,
          input.domain,
          input.urgency ?? 'normal',
          JSON.stringify(input.metadata ?? {}),
          signalId,
        ],
      );
      return { row: result.rows[0]!, created: true };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (signalId && code === '23505') {
        const recovered = await query<DecisionRow>(
          'SELECT * FROM decisions WHERE user_id = $1 AND signal_id = $2 LIMIT 1',
          [input.userId, signalId],
        );
        if (recovered.rows[0]) {
          const row = recovered.rows[0];
          const keyState = resolveKey(keyProvider, input.userId);
          const rawRead = readColumn(row.raw_event_encrypted, row.raw_event, keyState.key);
          const intRead = readColumn(row.interpreted_situation_encrypted, row.interpreted_situation, keyState.key);
          if (!rawRead.success || !intRead.success) {
            const err = !rawRead.success ? rawRead.error : intRead.error;
            throw new Error(`Vault Error: ${err} for user ${input.userId}`);
          }
          return { row: { ...row, raw_event: rawRead.value, interpreted_situation: intRead.value }, created: false };
        }
      }
      throw err;
    }
  },

  /**
   * Find a decision by its UUID.
   */
  async findById(id: string, keyProvider: VaultKeyProvider): Promise<DecisionRow | null> {
    const result = await query<DecisionRow>(
      'SELECT * FROM decisions WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;

    const keyState = resolveKey(keyProvider, row.user_id);
    const rawRead = readColumn(row.raw_event_encrypted, row.raw_event, keyState.key);
    const intRead = readColumn(row.interpreted_situation_encrypted, row.interpreted_situation, keyState.key);
    if (!rawRead.success || !intRead.success) {
      const err = !rawRead.success ? rawRead.error : intRead.error;
      throw new Error(`Vault Error: ${err} for user ${row.user_id}`);
    }
    return { ...row, raw_event: rawRead.value, interpreted_situation: intRead.value };
  },

  /**
   * Find decisions for a user with filtering and pagination.
   */
  async findByUser(
    userId: string,
    keyProvider: VaultKeyProvider,
    opts: UserQueryOptions = {},
  ): Promise<DecisionRow[]> {
    const keyState = resolveKey(keyProvider, userId);
    const conditions: string[] = ['user_id = $1'];
    const values: unknown[] = [userId];
    let paramIndex = 2;

    if (opts.domain) {
      conditions.push(`domain = $${paramIndex}`);
      values.push(opts.domain);
      paramIndex++;
    }

    if (opts.signalId) {
      conditions.push(`signal_id = $${paramIndex}`);
      values.push(opts.signalId);
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
    return result.rows.map(row => {
      const rawRead = readColumn(row.raw_event_encrypted, row.raw_event, keyState.key);
      const intRead = readColumn(row.interpreted_situation_encrypted, row.interpreted_situation, keyState.key);
      if (!rawRead.success || !intRead.success) {
        const err = !rawRead.success ? rawRead.error : intRead.error;
        throw new Error(`Vault Error: ${err} for user ${userId}`);
      }
      return { ...row, raw_event: rawRead.value, interpreted_situation: intRead.value };
    });
  },

  /**
   * Add a candidate action to a decision.
   */
  async addCandidateAction(
    input: CreateCandidateActionInput,
  ): Promise<CandidateActionRow> {
    return withTransaction(async (client) => {
      // Receipt capture locks the same decision row before reading candidate
      // authority and inserting its guard. Taking that lock first makes every
      // candidate INSERT/UPDATE serialize with capture in CockroachDB: the
      // loser observes the winner's committed guard/candidate state rather
      // than writing through an absent-guard snapshot.
      const decision = await client.query<{ id: string }>(
        'SELECT id FROM decisions WHERE id = $1 FOR UPDATE',
        [input.decisionId],
      );
      if (!decision.rows[0]) throw new Error('Candidate decision does not exist');

      const guard = await client.query(
        'SELECT 1 FROM decision_ingest_guards WHERE decision_id = $1',
        [input.decisionId],
      );
      if (guard.rows[0]) {
        throw new Error('Candidate action is immutable after receipt finalization');
      }

      if (input.id) {
        const result = await client.query<CandidateActionRow>(
          `INSERT INTO candidate_actions (
            id, decision_id, action_type, description, parameters,
            predicted_user_preference, risk_assessment, reversible, estimated_cost
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO UPDATE SET
            action_type = EXCLUDED.action_type,
            description = EXCLUDED.description,
            parameters = EXCLUDED.parameters,
            predicted_user_preference = EXCLUDED.predicted_user_preference,
            risk_assessment = EXCLUDED.risk_assessment,
            reversible = EXCLUDED.reversible,
            estimated_cost = EXCLUDED.estimated_cost
          WHERE candidate_actions.decision_id = EXCLUDED.decision_id
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
        const row = result.rows[0];
        if (!row) throw new Error('Candidate action belongs to another decision');
        return row;
      }
      const result = await client.query<CandidateActionRow>(
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
    });
  },

  /**
   * Replace a candidate's risk authority only while its decision remains
   * unfrozen. Lock ordering matches receipt capture (decision, then candidate)
   * so a concurrent capture either includes this risk or rejects this write.
   */
  async updateCandidateRiskAssessment(
    actionId: string,
    riskAssessment: Record<string, unknown>,
  ): Promise<CandidateActionRow> {
    return withTransaction(async (client) => {
      const decision = await client.query<{ id: string }>(
        `SELECT d.id FROM decisions d
         JOIN candidate_actions ca ON ca.decision_id = d.id
         WHERE ca.id = $1
         FOR UPDATE OF d`,
        [actionId],
      );
      const decisionId = decision.rows[0]?.id;
      if (!decisionId) throw new Error('Candidate action does not exist');

      const guard = await client.query(
        'SELECT 1 FROM decision_ingest_guards WHERE decision_id = $1',
        [decisionId],
      );
      if (guard.rows[0]) {
        throw new Error('Candidate risk is immutable after receipt finalization');
      }

      const updated = await client.query<CandidateActionRow>(
        `UPDATE candidate_actions
         SET risk_assessment = $1
         WHERE id = $2 AND decision_id = $3
         RETURNING *`,
        [JSON.stringify(riskAssessment), actionId, decisionId],
      );
      const row = updated.rows[0];
      if (!row) throw new Error('Candidate action disappeared during risk persistence');
      return row;
    });
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
    // Re-ingestion may replace the provisional outcome until receipt capture
    // finalizes it. Once a guard exists, the exact captured outcome remains
    // immutable continuation authority.
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
      WHERE NOT EXISTS (
        SELECT 1 FROM decision_ingest_guards g
        WHERE g.decision_id = EXCLUDED.decision_id
      )
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
    const row = result.rows[0];
    if (!row) {
      throw new Error('Decision outcome is immutable after receipt finalization');
    }
    return row;
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
