import type {
  CandidateAction,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStep,
  RollbackResult,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from './ironclaw-adapter.js';

/**
 * Mock implementation of the IronClaw adapter for development and testing.
 *
 * Simulates execution by logging actions and returning synthetic results.
 * All "executions" succeed after a small simulated delay.
 */
export class MockIronClawAdapter implements IronClawAdapter {
  private readonly _executedPlans = new Map<string, ExecutionPlan>();

  async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
    const steps: ExecutionStep[] = [
      {
        id: `step_${action.id}_1`,
        order: 1,
        type: 'prepare',
        description: `Prepare to execute: ${action.description}`,
        parameters: action.parameters,
        timeout: 5000,
      },
      {
        id: `step_${action.id}_2`,
        order: 2,
        type: 'execute',
        description: `Execute: ${action.actionType}`,
        parameters: action.parameters,
        timeout: 30000,
      },
      {
        id: `step_${action.id}_3`,
        order: 3,
        type: 'verify',
        description: `Verify execution of: ${action.actionType}`,
        parameters: {},
        timeout: 5000,
      },
    ];

    const rollbackSteps: ExecutionStep[] = action.reversible
      ? [
          {
            id: `rollback_${action.id}_1`,
            order: 1,
            type: 'rollback',
            description: `Rollback: ${action.actionType}`,
            parameters: action.parameters,
            timeout: 30000,
          },
        ]
      : [];

    const plan: ExecutionPlan = {
      id: `plan_${action.id}_${Date.now()}`,
      decisionId: action.decisionId,
      action,
      steps,
      rollbackSteps,
      createdAt: new Date(),
    };

    return plan;
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    // Simulate a small delay
    await new Promise((resolve) => setTimeout(resolve, 50));

    this._executedPlans.set(plan.id, plan);

    console.info(
      `[MockIronClaw] Executed plan ${plan.id}: ${plan.action.actionType} - ${plan.action.description}`,
    );

    return {
      planId: plan.id,
      status: 'completed',
      startedAt: new Date(Date.now() - 100),
      completedAt: new Date(),
      output: {
        actionType: plan.action.actionType,
        description: plan.action.description,
        mock: true,
        executedSteps: plan.steps.length,
      },
    };
  }

  async rollback(planId: string): Promise<RollbackResult> {
    const plan = this._executedPlans.get(planId);

    if (!plan) {
      return {
        success: false,
        message: `Plan ${planId} not found or was not executed.`,
      };
    }

    if (plan.rollbackSteps.length === 0) {
      return {
        success: false,
        message: `Plan ${planId} has no rollback steps (action was irreversible).`,
      };
    }

    this._executedPlans.delete(planId);

    console.info(
      `[MockIronClaw] Rolled back plan ${planId}: ${plan.action.actionType}`,
    );

    return {
      success: true,
      message: `Successfully rolled back plan ${planId}.`,
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    return {
      healthy: true,
      latencyMs: 1,
    };
  }

  /**
   * Get the list of executed plans (for testing/inspection).
   */
  getExecutedPlans(): Map<string, ExecutionPlan> {
    return new Map(this._executedPlans);
  }
}
