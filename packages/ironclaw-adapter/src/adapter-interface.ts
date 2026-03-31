import type { ExecutionPlan, ExecutionResult, ExecutionStatus, RollbackResult } from '@skytwin/shared-types';

/**
 * Extended adapter interface for the IronClaw execution layer.
 *
 * This interface adds getStatus() and healthCheck() as a boolean-only
 * variant. It can be used alongside the base IronClawAdapter from
 * ironclaw-adapter.ts.
 */
export interface IronClawExecutor {
  /**
   * Submit an execution plan for processing.
   */
  execute(plan: ExecutionPlan): Promise<ExecutionResult>;

  /**
   * Get the current status of an execution plan.
   */
  getStatus(planId: string): Promise<ExecutionStatus>;

  /**
   * Attempt to roll back a previously executed plan.
   */
  rollback(planId: string): Promise<RollbackResult>;

  /**
   * Check if the IronClaw service is healthy.
   */
  healthCheck(): Promise<boolean>;
}
