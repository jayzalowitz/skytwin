import { query } from '../connection.js';
import type { ExecutionPlanRow, ExecutionResultRow } from '../types.js';

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
   */
  async createPlan(input: CreateExecutionPlanInput): Promise<ExecutionPlanRow> {
    const result = await query<ExecutionPlanRow>(
      `INSERT INTO execution_plans (decision_id, action_id, status, steps)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        input.decisionId,
        input.actionId ?? null,
        input.status ?? 'pending',
        JSON.stringify(input.steps ?? []),
      ],
    );
    return result.rows[0]!;
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
      'SELECT * FROM execution_results WHERE plan_id = $1 ORDER BY started_at DESC LIMIT 1',
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
      'SELECT * FROM execution_results WHERE plan_id = $1 ORDER BY started_at DESC LIMIT 1',
      [planId],
    );
    return result.rows[0] ?? null;
  },
};
