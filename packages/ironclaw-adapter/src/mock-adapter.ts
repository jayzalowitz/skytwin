import type { ExecutionPlan, ExecutionResult, ExecutionStatus, RollbackResult } from '@skytwin/shared-types';
import type { IronClawExecutor } from './adapter-interface.js';

/**
 * A log entry recording an operation performed by the mock adapter.
 */
export interface OperationLog {
  timestamp: Date;
  operation: 'execute' | 'status_check' | 'rollback' | 'health_check';
  planId: string | null;
  result: string;
  details?: Record<string, unknown>;
}

/**
 * Configuration for the mock adapter's behavior.
 */
export interface MockAdapterConfig {
  /** Base execution delay in milliseconds. Default: 100 */
  executionDelayMs: number;
  /** Probability of simulated failure (0-1). Default: 0.05 */
  failureProbability: number;
  /** Whether to simulate execution delays. Default: true */
  simulateDelays: boolean;
}

const DEFAULT_CONFIG: MockAdapterConfig = {
  executionDelayMs: 100,
  failureProbability: 0.05,
  simulateDelays: true,
};

/**
 * MockIronClawAdapter simulates the IronClaw execution layer for
 * development and testing. It:
 * - Simulates execution with configurable delays
 * - Returns success for most actions
 * - Simulates occasional failures based on configured probability
 * - Supports rollback for plans with rollback steps
 * - Logs all operations for inspection
 */
export class MockIronClawAdapter implements IronClawExecutor {
  private readonly config: MockAdapterConfig;
  private readonly plans: Map<string, ExecutionResult> = new Map();
  private readonly planData: Map<string, ExecutionPlan> = new Map();
  private readonly logs: OperationLog[] = [];
  private healthy = true;

  constructor(config: Partial<MockAdapterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Simulate executing a plan. Applies configurable delays and
   * occasional failures.
   */
  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    this.log('execute', plan.id, 'starting');

    // Store the plan for potential rollback
    this.planData.set(plan.id, plan);

    // Create initial pending result
    const result: ExecutionResult = {
      planId: plan.id,
      status: 'pending',
      startedAt: new Date(),
    };

    this.plans.set(plan.id, result);

    // Simulate execution delay
    if (this.config.simulateDelays) {
      await this.delay(this.config.executionDelayMs);
    }

    // Update to running
    result.status = 'running';
    this.plans.set(plan.id, result);

    // Simulate step execution
    for (const step of plan.steps) {
      if (this.config.simulateDelays) {
        await this.delay(Math.min(step.timeout / 10, this.config.executionDelayMs));
      }

      // Check for simulated failure
      if (Math.random() < this.config.failureProbability) {
        result.status = 'failed';
        result.completedAt = new Date();
        result.error = `Simulated failure at step ${step.order}: ${step.description}`;
        this.plans.set(plan.id, result);
        this.log('execute', plan.id, `failed at step ${step.order}`, {
          step: step.id,
          error: result.error,
        });
        return result;
      }
    }

    // Execution succeeded
    result.status = 'completed';
    result.completedAt = new Date();
    result.output = {
      stepsCompleted: plan.steps.length,
      actionType: plan.action.actionType,
      description: plan.action.description,
    };

    this.plans.set(plan.id, result);
    this.log('execute', plan.id, 'completed successfully', {
      stepsCompleted: plan.steps.length,
      durationMs: result.completedAt.getTime() - result.startedAt.getTime(),
    });

    return result;
  }

  /**
   * Get the current status of an execution plan.
   */
  async getStatus(planId: string): Promise<ExecutionStatus> {
    this.log('status_check', planId, 'checking');

    const result = this.plans.get(planId);
    if (!result) {
      this.log('status_check', planId, 'not found');
      throw new Error(`No execution found for plan ID: ${planId}`);
    }

    return result.status;
  }

  /**
   * Attempt to roll back a previously executed plan.
   */
  async rollback(planId: string): Promise<RollbackResult> {
    this.log('rollback', planId, 'starting');

    const plan = this.planData.get(planId);
    const result = this.plans.get(planId);

    if (!plan || !result) {
      this.log('rollback', planId, 'plan not found');
      return {
        success: false,
        message: `No execution plan found for ID: ${planId}`,
      };
    }

    // Can only rollback completed or failed executions
    if (result.status !== 'completed' && result.status !== 'failed') {
      this.log('rollback', planId, `cannot rollback - status is ${result.status}`);
      return {
        success: false,
        message: `Cannot rollback a plan in "${result.status}" status. Must be completed or failed.`,
      };
    }

    // Check if rollback steps exist
    if (!plan.rollbackSteps || plan.rollbackSteps.length === 0) {
      this.log('rollback', planId, 'no rollback steps defined');
      return {
        success: false,
        message: 'This action is not reversible. No rollback steps were defined.',
      };
    }

    // Check if the underlying action is reversible
    if (!plan.action.reversible) {
      this.log('rollback', planId, 'action is not reversible');
      return {
        success: false,
        message: 'The action associated with this plan is marked as irreversible.',
      };
    }

    // Simulate rollback execution
    if (this.config.simulateDelays) {
      await this.delay(this.config.executionDelayMs);
    }

    // Execute rollback steps
    for (const step of plan.rollbackSteps) {
      if (this.config.simulateDelays) {
        await this.delay(Math.min(step.timeout / 10, this.config.executionDelayMs / 2));
      }

      // Rollback failures are less common than execution failures
      if (Math.random() < this.config.failureProbability / 2) {
        this.log('rollback', planId, `failed at rollback step ${step.order}`);
        return {
          success: false,
          message: `Rollback failed at step ${step.order}: ${step.description}. Manual intervention may be required.`,
        };
      }
    }

    // Update the execution status
    result.status = 'completed';
    result.output = {
      ...result.output,
      rolledBack: true,
      rollbackTime: new Date().toISOString(),
    };
    this.plans.set(planId, result);

    this.log('rollback', planId, 'completed successfully', {
      rollbackSteps: plan.rollbackSteps.length,
    });

    return {
      success: true,
      message: `Successfully rolled back ${plan.rollbackSteps.length} step(s).`,
    };
  }

  /**
   * Check if the mock service is "healthy".
   */
  async healthCheck(): Promise<boolean> {
    this.log('health_check', null, this.healthy ? 'healthy' : 'unhealthy');
    return this.healthy;
  }

  // ── Testing helpers ──────────────────────────────────────────────

  /**
   * Set the health status (for testing failure scenarios).
   */
  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  /**
   * Get all operation logs.
   */
  getLogs(): readonly OperationLog[] {
    return this.logs;
  }

  /**
   * Clear all logs.
   */
  clearLogs(): void {
    this.logs.length = 0;
  }

  /**
   * Get a specific execution result.
   */
  getResult(planId: string): ExecutionResult | undefined {
    return this.plans.get(planId);
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.plans.clear();
    this.planData.clear();
    this.logs.length = 0;
    this.healthy = true;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private log(
    operation: OperationLog['operation'],
    planId: string | null,
    result: string,
    details?: Record<string, unknown>,
  ): void {
    this.logs.push({
      timestamp: new Date(),
      operation,
      planId,
      result,
      details,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
