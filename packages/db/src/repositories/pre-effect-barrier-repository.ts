import { query } from '../connection.js';

export type PreEffectType =
  | 'assistant_approval'
  | 'event_execution'
  | 'memory_execution'
  | 'routine_registration';

export type PreEffectBarrierStatus =
  | 'reserved'
  | 'prepared'
  | 'in_progress'
  | 'succeeded'
  | 'blocked'
  | 'failed'
  | 'unknown';

export interface PreEffectBarrierRow {
  id: string;
  user_id: string;
  effect_type: PreEffectType;
  idempotency_key: string;
  status: PreEffectBarrierStatus;
  decision_id: string | null;
  action_id: string | null;
  explanation_id: string | null;
  policy_snapshot: Record<string, unknown>;
  effect_result: Record<string, unknown>;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReservePreEffectInput {
  userId: string;
  effectType: PreEffectType;
  idempotencyKey: string;
}

export interface PreparePreEffectInput {
  id: string;
  userId: string;
  decisionId: string;
  actionId: string;
  explanationId: string;
  policySnapshot: Record<string, unknown>;
}

export interface TerminalPreEffectWithExplanationInput {
  id: string;
  userId: string;
  explanationId: string;
  decisionId: string;
  actionId: string;
  status: Extract<PreEffectBarrierStatus, 'blocked' | 'failed'>;
  effectResult?: Record<string, unknown>;
  failureReason?: string;
}

/**
 * Durable, user-scoped admission barrier for adapters without idempotency-key
 * support. Only the `prepared -> in_progress` winner may call the adapter.
 */
export const preEffectBarrierRepository = {
  async reserve(input: ReservePreEffectInput): Promise<{ row: PreEffectBarrierRow; created: boolean }> {
    const inserted = await query<PreEffectBarrierRow>(
      `INSERT INTO pre_effect_barriers (user_id, effect_type, idempotency_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, effect_type, idempotency_key) DO NOTHING
       RETURNING *`,
      [input.userId, input.effectType, input.idempotencyKey],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };

    const existing = await query<PreEffectBarrierRow>(
      `SELECT * FROM pre_effect_barriers
       WHERE user_id = $1 AND effect_type = $2 AND idempotency_key = $3`,
      [input.userId, input.effectType, input.idempotencyKey],
    );
    if (!existing.rows[0]) throw new Error('Pre-effect barrier conflict could not be recovered.');
    return { row: existing.rows[0], created: false };
  },

  async markPrepared(input: PreparePreEffectInput): Promise<PreEffectBarrierRow> {
    const result = await query<PreEffectBarrierRow>(
      `UPDATE pre_effect_barriers
       SET status = 'prepared', decision_id = $3, action_id = $4,
           explanation_id = $5, policy_snapshot = $6, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'reserved'
         AND EXISTS (
           SELECT 1
             FROM decisions AS decision
             JOIN candidate_actions AS action
               ON action.id = $4 AND action.decision_id = decision.id
             JOIN explanation_records AS explanation
               ON explanation.id = $5 AND explanation.decision_id = decision.id
            WHERE decision.id = $3 AND decision.user_id = $2
         )
       RETURNING *`,
      [input.id, input.userId, input.decisionId, input.actionId, input.explanationId, JSON.stringify(input.policySnapshot)],
    );
    if (!result.rows[0]) throw new Error('Pre-effect barrier was not reserved.');
    return result.rows[0];
  },

  async claimPrepared(userId: string, id: string): Promise<PreEffectBarrierRow | null> {
    const result = await query<PreEffectBarrierRow>(
      `UPDATE pre_effect_barriers
       SET status = 'in_progress', updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'prepared'
       RETURNING *`,
      [id, userId],
    );
    return result.rows[0] ?? null;
  },

  async updatePreparedPolicy(
    userId: string,
    id: string,
    policySnapshot: Record<string, unknown>,
  ): Promise<PreEffectBarrierRow> {
    const result = await query<PreEffectBarrierRow>(
      `UPDATE pre_effect_barriers
       SET policy_snapshot = $3, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'prepared'
       RETURNING *`,
      [id, userId, JSON.stringify(policySnapshot)],
    );
    if (!result.rows[0]) throw new Error('Prepared policy snapshot could not be refreshed.');
    return result.rows[0];
  },

  async markTerminal(
    userId: string,
    id: string,
    status: Extract<PreEffectBarrierStatus, 'succeeded' | 'blocked' | 'failed' | 'unknown'>,
    effectResult: Record<string, unknown> = {},
    failureReason?: string,
  ): Promise<PreEffectBarrierRow> {
    const result = await query<PreEffectBarrierRow>(
      `UPDATE pre_effect_barriers
       SET status = $3, effect_result = $4, failure_reason = $5, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND (
         ($3 IN ('succeeded', 'unknown') AND status = 'in_progress') OR
         ($3 IN ('blocked', 'failed') AND status IN ('reserved', 'prepared', 'in_progress'))
       )
       RETURNING *`,
      [id, userId, status, JSON.stringify(effectResult), failureReason ?? null],
    );
    if (!result.rows[0]) throw new Error('Pre-effect barrier not found.');
    return result.rows[0];
  },

  /**
   * Atomically attach an already-persisted, owner-scoped explanation while
   * terminalizing a known no-dispatch outcome. If explanation persistence
   * failed, callers never invoke this method and the reservation remains
   * fail-closed for reconciliation rather than claiming an unexplained result.
   */
  async markTerminalWithExplanation(
    input: TerminalPreEffectWithExplanationInput,
  ): Promise<PreEffectBarrierRow> {
    const result = await query<PreEffectBarrierRow>(
      `UPDATE pre_effect_barriers AS barrier
       SET status = $6, decision_id = $4, action_id = $5,
           explanation_id = $3, effect_result = $7,
           failure_reason = $8, updated_at = now()
       WHERE barrier.id = $1 AND barrier.user_id = $2
         AND barrier.status IN ('reserved', 'prepared', 'in_progress')
         AND (barrier.decision_id IS NULL OR barrier.decision_id = $4)
         AND (barrier.action_id IS NULL OR barrier.action_id = $5)
         AND EXISTS (
           SELECT 1
             FROM decisions AS decision
             JOIN candidate_actions AS action
               ON action.id = $5 AND action.decision_id = decision.id
             JOIN explanation_records AS explanation
               ON explanation.id = $3 AND explanation.decision_id = decision.id
            WHERE decision.id = $4 AND decision.user_id = $2
         )
       RETURNING barrier.*`,
      [
        input.id,
        input.userId,
        input.explanationId,
        input.decisionId,
        input.actionId,
        input.status,
        JSON.stringify(input.effectResult ?? {}),
        input.failureReason ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new Error('Owned explanation could not be attached to the pre-effect barrier.');
    }
    return result.rows[0];
  },
};
