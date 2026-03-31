import type {
  CandidateAction,
  ExecutionPlan,
  ExecutionResult,
  RollbackResult,
} from '@skytwin/shared-types';

/**
 * Interface for adapting SkyTwin's decision output to IronClaw's execution layer.
 *
 * IronClaw is the underlying execution engine that actually performs actions
 * (sending emails, making API calls, placing orders, etc.). SkyTwin delegates
 * to IronClaw after deciding what to do and confirming it passes all safety checks.
 */
export interface IronClawAdapter {
  /**
   * Build an execution plan from a candidate action.
   */
  buildPlan(action: CandidateAction): Promise<ExecutionPlan>;

  /**
   * Execute a plan and return the result.
   */
  execute(plan: ExecutionPlan): Promise<ExecutionResult>;

  /**
   * Attempt to roll back a previously executed plan.
   */
  rollback(planId: string): Promise<RollbackResult>;

  /**
   * Check if IronClaw is healthy and reachable.
   */
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number }>;
}
