import { query, withTransaction } from '../connection.js';
import {
  normalizeAdapterOutput,
  normalizeExecutionError,
  normalizeExecutionEventPayload,
  normalizeExecutionEventType,
  normalizeExecutionIdentifier,
  normalizeExecutionPlanSteps,
  normalizeMemoryActionAdapterName,
} from '@skytwin/shared-types';
import type { ExecutionEventRow, ExecutionPlanRow, ExecutionResultRow } from '../types.js';

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

function normalizeResultRow(row: ExecutionResultRow): ExecutionResultRow {
  return {
    ...row,
    outputs: normalizeAdapterOutput(row.outputs),
    error: row.error ? normalizeExecutionError(row.error) : null,
  };
}

function normalizeEventRow(row: ExecutionEventRow): ExecutionEventRow {
  return {
    ...row,
    step_id: row.step_id ? normalizeExecutionIdentifier(row.step_id) : null,
    event_type: normalizeExecutionEventType(row.event_type),
    payload: normalizeExecutionEventPayload(row.payload),
  };
}

function normalizePlanRow(row: ExecutionPlanRow): ExecutionPlanRow {
  return { ...row, steps: normalizeExecutionPlanSteps(row.steps) };
}

/**
 * Input for creating an execution plan.
 */
export interface CreateExecutionPlanInput {
  decisionId: string;
  actionId?: string;
  status?: string;
  steps?: unknown[];
}

/**
 * Input for creating an execution result.
 */
export interface CreateExecutionResultInput {
  planId: string;
  success: boolean;
  outputs?: Record<string, unknown>;
  error?: string;
  rollbackAvailable?: boolean;
}

export interface FinalizeAdmittedExecutionInput extends CreateExecutionResultInput {
  userId: string;
  decisionId: string;
  actionId: string;
  status: 'completed' | 'failed';
}

export interface CreateExecutionEventInput {
  planId: string;
  stepId?: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

/**
 * A plan paired with its (optional) result.
 */
export interface ExecutionPlanWithResult {
  plan: ExecutionPlanRow;
  result: ExecutionResultRow | null;
}

/**
 * One rollback candidate resolved for a capability server's recent actions.
 *
 * #324: this is the materialized output of the
 * `capability_provenance_nodes → decision_outcomes → execution_plans →
 * execution_results` join the `regret` endpoint needs. `executionPlanId` is the
 * exact completed plan ID (NULL when the validated graph is absent);
 * `adapterUsed` identifies the adapter recorded on its successful reversible
 * result. This is report metadata only until a durable rollback lifecycle owns
 * any future dispatch.
 */
export interface RollbackTarget {
  /** The provenance node's `ref_id` — the candidate action id. */
  readonly actionId: string;
  /**
   * Action type read through the exact owner/decision/outcome/plan binding.
   * NULL means that immutable graph is absent or inconsistent and therefore
   * cannot authorize generic rollback dispatch.
   */
  readonly actionType: string | null;
  /** Reversibility from the exactly bound candidate row, never provenance JSON. */
  readonly reversible: boolean | null;
  /** Raw provenance payload; presentation metadata only. */
  readonly payload: Record<string, unknown> | null;
  readonly occurredAt: Date;
  /** Real execution plan id resolved via the #324 FK, or NULL if unlinked. */
  readonly executionPlanId: string | null;
  /** Adapter that executed the plan, or NULL if not recorded / no result. */
  readonly adapterUsed: string | null;
}

/**
 * Repository for execution plan and result operations.
 */
export const executionRepository = {
  /**
   * Create a new execution plan.
   *
   * #324: also updates `decision_outcomes.execution_plan_id` for the
   * matching `decision_id` in the same transaction. This closes the
   * structural linkage gap that previously forced the rollback /
   * approval-ratio queries in `capabilities.ts` to proxy via
   * `capability_provenance_nodes`. If no outcome row exists yet
   * (decision still being processed), the UPDATE no-ops — the
   * outcome insert path doesn't need to be involved, since the
   * approval-pending flow creates the outcome before the plan and
   * the auto-execute flow creates them in order.
   *
   * Both operations share one CockroachDB transaction so either both
   * succeed or both roll back — the FK is never stale.
   */
  async createPlan(input: CreateExecutionPlanInput): Promise<ExecutionPlanRow> {
    return withTransaction(async (client) => {
      const insertResult = await client.query<ExecutionPlanRow>(
        `INSERT INTO execution_plans (decision_id, action_id, status, steps, evidence_schema_version)
         VALUES ($1, $2, $3, $4, 1)
         RETURNING *`,
        [
          input.decisionId || null,
          input.actionId || null,
          input.status ?? 'pending',
          JSON.stringify(normalizeExecutionPlanSteps(input.steps ?? [])),
        ],
      );
      const plan = normalizePlanRow(insertResult.rows[0]!);

      if (input.decisionId) {
        // Link the matching outcome to this plan. "Latest plan wins" —
        // every new plan overwrites the outcome's pointer to itself.
        // This matches both:
        //   - the migration 055 backfill, which picks the latest plan
        //     (`ORDER BY created_at DESC`) for existing rows, and
        //   - `executionRepository.getByDecisionId`'s
        //     `ORDER BY created_at DESC LIMIT 1` read semantics.
        // Historical plans for the same decision are still reachable
        // via `SELECT * FROM execution_plans WHERE decision_id = ?` —
        // the outcome's FK is the "current plan" pointer, not an
        // immutable first-write record. (Copilot caught the prior
        // `WHERE execution_plan_id IS NULL` guard as inconsistent
        // with backfill + read paths.)
        await client.query(
          `UPDATE decision_outcomes
             SET execution_plan_id = $1
           WHERE decision_id = $2`,
          [plan.id, input.decisionId],
        );
      }

      return plan;
    });
  },

  /**
   * Update the status of an execution plan.
   * Returns null if the plan does not exist.
   */
  async updatePlanStatus(
    planId: string,
    status: string,
  ): Promise<ExecutionPlanRow | null> {
    const result = await query<ExecutionPlanRow>(
      `UPDATE execution_plans
       SET status = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [status, planId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Record the result of an execution plan.
   */
  async createResult(
    input: CreateExecutionResultInput,
  ): Promise<ExecutionResultRow> {
    const outputs = normalizeAdapterOutput(input.outputs ?? {});
    const error = input.error ? normalizeExecutionError(input.error) : null;
    const result = await query<ExecutionResultRow>(
      `INSERT INTO execution_results (plan_id, success, outputs, error, rollback_available, completed_at,
                                      evidence_schema_version)
       VALUES ($1, $2, $3, $4, $5, now(), 1)
       RETURNING *`,
      [
        input.planId,
        input.success,
        JSON.stringify(outputs),
        error,
        input.rollbackAvailable ?? false,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Materialize the secondary execution ledger for a plan that was durably
   * admitted before dispatch. This operation is idempotent for the exact same
   * terminal result, which lets callers reconcile a lost commit response
   * without inventing a second plan or changing terminal truth.
   */
  async finalizeAdmittedPlan(input: FinalizeAdmittedExecutionInput): Promise<ExecutionPlanRow> {
    return withTransaction(async (client) => {
      const outputs = normalizeAdapterOutput(input.outputs ?? {});
      const error = input.error ? normalizeExecutionError(input.error) : null;
      const locked = await client.query<ExecutionPlanRow>(
        `SELECT ep.* FROM execution_plans ep
         JOIN decisions d ON d.id = ep.decision_id AND d.user_id = $1
         JOIN execution_admission_barriers b
           ON b.execution_plan_id = ep.id AND b.user_id = d.user_id
          AND b.decision_id = ep.decision_id AND b.action_id = ep.action_id
         WHERE ep.id = $2 AND ep.decision_id = $3 AND ep.action_id = $4
           AND b.status IN ('in_progress', $5)
         FOR UPDATE OF ep, d, b`,
        [input.userId, input.planId, input.decisionId, input.actionId, input.status],
      );
      const plan = locked.rows[0];
      if (!plan || (plan.status !== 'running' && plan.status !== input.status)) {
        throw new Error('Admitted execution plan authority is unavailable.');
      }

      await client.query(
        `INSERT INTO execution_results
          (plan_id, success, outputs, error, rollback_available, completed_at,
           evidence_schema_version)
         VALUES ($1, $2, $3::JSONB, $4, $5, now(), 1)
         ON CONFLICT (plan_id) DO NOTHING`,
        [input.planId, input.success, JSON.stringify(outputs),
          error, input.rollbackAvailable ?? false],
      );
      const persistedResult = await client.query<ExecutionResultRow>(
        `SELECT * FROM execution_results WHERE plan_id = $1`,
        [input.planId],
      );
      const result = persistedResult.rows[0];
      if (!result || result.success !== input.success ||
          canonicalJson(result.outputs) !== canonicalJson(outputs) ||
          (result.error ?? null) !== error ||
          result.rollback_available !== (input.rollbackAvailable ?? false)) {
        throw new Error('Admitted execution result conflicts with persisted terminal truth.');
      }

      const terminal = await client.query<ExecutionPlanRow>(
        `UPDATE execution_plans ep
         SET status = $2, updated_at = now()
         WHERE ep.id = $1 AND ep.status IN ('running', $2)
           AND EXISTS (
             SELECT 1 FROM execution_results er
             WHERE er.plan_id = ep.id AND er.success = ($2 = 'completed')
           )
         RETURNING ep.*`,
        [input.planId, input.status],
      );
      if (!terminal.rows[0]) throw new Error('Admitted execution plan could not be terminalized.');
      await client.query(
        `UPDATE decision_outcomes o
         SET execution_plan_id = $1
         WHERE o.decision_id = $2 AND o.selected_action_id = $3
           AND EXISTS (
             SELECT 1 FROM decisions d WHERE d.id = o.decision_id AND d.user_id = $4
           )`,
        [input.planId, input.decisionId, input.actionId, input.userId],
      );
      return terminal.rows[0];
    });
  },

  /**
   * Get the execution plan (and its result, if any) for a given decision.
   * Returns null if no plan exists for the decision.
   */
  async getByDecisionId(
    decisionId: string,
  ): Promise<ExecutionPlanWithResult | null> {
    const planResult = await query<ExecutionPlanRow>(
      'SELECT * FROM execution_plans WHERE decision_id = $1 ORDER BY created_at DESC LIMIT 1',
      [decisionId],
    );

    const plan = planResult.rows[0] ? normalizePlanRow(planResult.rows[0]) : undefined;
    if (!plan) return null;

    const resultResult = await query<ExecutionResultRow>(
      'SELECT * FROM execution_results WHERE plan_id = $1 ORDER BY completed_at DESC LIMIT 1',
      [plan.id],
    );

    return {
      plan,
      result: resultResult.rows[0] ? normalizeResultRow(resultResult.rows[0]) : null,
    };
  },

  /**
   * Resolve rollback targets for a capability server's recent actions (#324).
   *
   * Walks `capability_provenance_nodes` (the server↔action attribution) and,
   * for each `action` node, resolves the real execution plan via the #324
   * `decision_outcomes.execution_plan_id` FK plus the successful reversible
   * result's recorded adapter. The `regret` endpoint uses this for a truthful
   * report only; it does not authorize or dispatch a rollback.
   *
   * The outer lateral subquery independently binds candidate identity/type and
   * reversibility through its owner-scoped decision. Its nested lateral lookup
   * exposes plan/adapter metadata only when the current outcome plan identifies
   * that same action and has a qualifying result. This preserves archive and
   * reversibility classification even when plan metadata must fail closed.
   */
  async getRollbackTargetsByServer(input: {
    serverId: string;
    userId: string;
    since: Date;
  }): Promise<readonly RollbackTarget[]> {
    const result = await query<{
      ref_id: string;
      payload: Record<string, unknown> | null;
      occurred_at: Date;
      execution_plan_id: string | null;
      adapter_used: string | null;
      action_type: string | null;
      reversible: boolean | null;
    }>(
      `SELECT pn.ref_id,
              pn.payload,
              pn.occurred_at,
              link.execution_plan_id,
              link.action_type,
              link.reversible,
              link.adapter_used
         FROM capability_provenance_nodes pn
         LEFT JOIN LATERAL (
                SELECT candidate.action_type,
                       candidate.reversible,
                       qualified.execution_plan_id,
                       qualified.adapter_used
                  FROM candidate_actions candidate
                  JOIN decisions decision
                    ON decision.id = candidate.decision_id
                   AND decision.user_id = pn.user_id
                  JOIN decision_outcomes doc
                    ON doc.decision_id = decision.id
                   AND doc.selected_action_id = candidate.id
                  LEFT JOIN LATERAL (
                    SELECT plan.id AS execution_plan_id,
                           latest_result.outputs->>'adapter_used' AS adapter_used
                      FROM execution_plans plan
                      JOIN LATERAL (
                        SELECT result.*
                          FROM execution_results result
                         WHERE result.plan_id = plan.id
                         ORDER BY result.completed_at DESC, result.id DESC
                         LIMIT 1
                      ) latest_result ON true
                     WHERE plan.id = doc.execution_plan_id
                       AND plan.decision_id = decision.id
                       AND plan.action_id = candidate.id
                       AND plan.status = 'completed'
                       AND latest_result.success = true
                       AND latest_result.rollback_available = true
                       AND nullif(latest_result.outputs->>'adapter_used', '') IS NOT NULL
                     LIMIT 1
                  ) qualified ON true
                 WHERE candidate.id = pn.ref_id
                 LIMIT 1
              ) link ON true
        WHERE pn.server_id = $1
          AND pn.node_type = 'action'
          AND pn.occurred_at >= $2
          AND pn.user_id = $3
        ORDER BY pn.occurred_at DESC, pn.id DESC`,
      [input.serverId, input.since, input.userId],
    );

    return Object.freeze(result.rows.map((row) => Object.freeze({
      actionId: row.ref_id,
      actionType: row.action_type,
      reversible: row.reversible,
      payload: row.payload,
      occurredAt: row.occurred_at,
      executionPlanId: row.execution_plan_id,
      adapterUsed: normalizeMemoryActionAdapterName(row.adapter_used),
    })));
  },

  /**
   * Get the execution result for a given plan.
   * Returns null if no result has been recorded yet.
   */
  async getResultByPlan(
    planId: string,
  ): Promise<ExecutionResultRow | null> {
    const result = await query<ExecutionResultRow>(
      'SELECT * FROM execution_results WHERE plan_id = $1 ORDER BY completed_at DESC LIMIT 1',
      [planId],
    );
    return result.rows[0] ? normalizeResultRow(result.rows[0]) : null;
  },

  async createEvent(input: CreateExecutionEventInput): Promise<ExecutionEventRow> {
    const payload = normalizeExecutionEventPayload(input.payload ?? {});
    const eventType = normalizeExecutionEventType(input.eventType);
    const stepId = input.stepId === undefined ? null : normalizeExecutionIdentifier(input.stepId);
    if (eventType === 'unknown' || (input.stepId !== undefined && !stepId)) {
      throw new Error('Execution event identity is malformed.');
    }
    const result = await query<ExecutionEventRow>(
      `INSERT INTO execution_events (plan_id, step_id, event_type, payload, evidence_schema_version)
       VALUES ($1, $2, $3, $4, 1)
       RETURNING *`,
      [
        input.planId,
        stepId,
        eventType,
        JSON.stringify(payload),
      ],
    );
    return result.rows[0]!;
  },

  async getEventsByPlan(planId: string): Promise<ExecutionEventRow[]> {
    const result = await query<ExecutionEventRow>(
      'SELECT * FROM execution_events WHERE plan_id = $1 ORDER BY created_at ASC',
      [planId],
    );
    return result.rows.map(normalizeEventRow);
  },
};
