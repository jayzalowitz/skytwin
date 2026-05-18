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
