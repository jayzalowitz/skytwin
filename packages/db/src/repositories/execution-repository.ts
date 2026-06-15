import { query, withTransaction } from '../connection.js';
import type { ExecutionEventRow, ExecutionPlanRow, ExecutionResultRow } from '../types.js';

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
 * real plan ID `IronClawAdapter.rollback(planId)` acts on (NULL when no outcome
 * links to a plan yet); `adapterUsed` is the adapter that executed the plan
 * (read from `execution_results.outputs.adapter_used`) so rollback can route
 * back to the SAME adapter that performed the action.
 */
export interface RollbackTarget {
  /** The provenance node's `ref_id` — the candidate action id. */
  actionId: string;
  /** Raw provenance payload (carries `reversible` + `irreversibleReason`). */
  payload: Record<string, unknown> | null;
  occurredAt: Date;
  /** Real execution plan id resolved via the #324 FK, or NULL if unlinked. */
  executionPlanId: string | null;
  /** Adapter that executed the plan, or NULL if not recorded / no result. */
  adapterUsed: string | null;
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
        `INSERT INTO execution_plans (decision_id, action_id, status, steps)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          input.decisionId || null,
          input.actionId || null,
          input.status ?? 'pending',
          JSON.stringify(input.steps ?? []),
        ],
      );
      const plan = insertResult.rows[0]!;

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
    const result = await query<ExecutionResultRow>(
      `INSERT INTO execution_results (plan_id, success, outputs, error, rollback_available, completed_at)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING *`,
      [
        input.planId,
        input.success,
        JSON.stringify(input.outputs ?? {}),
        input.error ?? null,
        input.rollbackAvailable ?? false,
      ],
    );
    return result.rows[0]!;
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

    const plan = planResult.rows[0];
    if (!plan) return null;

    const resultResult = await query<ExecutionResultRow>(
      'SELECT * FROM execution_results WHERE plan_id = $1 ORDER BY completed_at DESC LIMIT 1',
      [plan.id],
    );

    return {
      plan,
      result: resultResult.rows[0] ?? null,
    };
  },

  /**
   * Resolve rollback targets for a capability server's recent actions (#324).
   *
   * Walks `capability_provenance_nodes` (the server↔action attribution) and,
   * for each `action` node, resolves the real execution plan via the #324
   * `decision_outcomes.execution_plan_id` FK plus the adapter that executed it
   * via `execution_results.outputs->>'adapter_used'`. The `regret` endpoint
   * uses this to dispatch `IronClawAdapter.rollback(planId)` through the
   * execution router, targeting the SAME adapter that ran the action.
   *
   * SUBQUERY (not LEFT JOIN) for `execution_plan_id`: `selected_action_id`
   * should be unique per outcome but there is no DB constraint enforcing it, so
   * a LEFT JOIN could duplicate the provenance row. `LIMIT 1` keeps one row per
   * provenance node regardless. The adapter lookup is similarly a scalar
   * subquery against the latest result for the resolved plan.
   */
  async getRollbackTargetsByServer(input: {
    serverId: string;
    userId: string;
    since: Date;
  }): Promise<RollbackTarget[]> {
    const result = await query<{
      ref_id: string;
      payload: Record<string, unknown> | null;
      occurred_at: Date;
      execution_plan_id: string | null;
      adapter_used: string | null;
    }>(
      `SELECT pn.ref_id,
              pn.payload,
              pn.occurred_at,
              link.execution_plan_id,
              (SELECT er.outputs->>'adapter_used'
                 FROM execution_results er
                WHERE er.plan_id = link.execution_plan_id
                ORDER BY er.completed_at DESC
                LIMIT 1) AS adapter_used
         FROM capability_provenance_nodes pn
         LEFT JOIN LATERAL (
                SELECT doc.execution_plan_id
                  FROM decision_outcomes doc
                 WHERE doc.selected_action_id = pn.ref_id
                 LIMIT 1
              ) link ON true
        WHERE pn.server_id = $1
          AND pn.node_type = 'action'
          AND pn.occurred_at >= $2
          AND pn.user_id = $3
        ORDER BY pn.occurred_at DESC`,
      [input.serverId, input.since, input.userId],
    );

    return result.rows.map((row) => ({
      actionId: row.ref_id,
      payload: row.payload,
      occurredAt: row.occurred_at,
      executionPlanId: row.execution_plan_id,
      adapterUsed: row.adapter_used,
    }));
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
    return result.rows[0] ?? null;
  },

  async createEvent(input: CreateExecutionEventInput): Promise<ExecutionEventRow> {
    const result = await query<ExecutionEventRow>(
      `INSERT INTO execution_events (plan_id, step_id, event_type, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        input.planId,
        input.stepId ?? null,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  async getEventsByPlan(planId: string): Promise<ExecutionEventRow[]> {
    const result = await query<ExecutionEventRow>(
      'SELECT * FROM execution_events WHERE plan_id = $1 ORDER BY created_at ASC',
      [planId],
    );
    return result.rows;
  },
};
