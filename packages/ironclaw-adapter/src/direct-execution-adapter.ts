import type {
  CandidateAction,
  ExecutionEvent,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStatus,
  ExecutionStep,
  RollbackResult,
  StepResult,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from './ironclaw-adapter.js';
import type { ActionHandlerRegistry } from './handler-registry.js';

/**
 * Direct execution adapter that dispatches actions to locally registered handlers.
 *
 * This adapter calls external APIs (Gmail, Calendar, etc.) directly via the
 * handler registry — bypassing IronClaw's execution runtime entirely.
 *
 * Use this only as a fallback when IronClaw is not available, or for local
 * development scenarios where you want direct API access without running
 * an IronClaw server. For production use, prefer RealIronClawAdapter which
 * routes execution through IronClaw's sandboxed tool system.
 */
export class DirectExecutionAdapter implements IronClawAdapter {
  private readonly executedPlans = new Map<string, ExecutionPlan>();
  private readonly planStatuses = new Map<string, ExecutionStatus>();

  constructor(private readonly registry: ActionHandlerRegistry) {}

  async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
    const planId = (action.parameters['executionPlanId'] as string | undefined)
      ?? `plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date();

    const step: ExecutionStep = {
      id: `step_${planId}_1`,
      order: 1,
      type: action.actionType,
      description: action.description,
      parameters: {
        ...action.parameters,
        actionType: action.actionType,
        domain: action.domain,
        estimatedCostCents: action.estimatedCostCents,
      },
      timeout: 30000,
    };

    const rollbackSteps: ExecutionStep[] = action.reversible
      ? [
          {
            id: `step_${planId}_rollback_1`,
            order: 1,
            type: `rollback_${action.actionType}`,
            description: `Rollback: ${action.description}`,
            parameters: { ...action.parameters, originalActionType: action.actionType },
            timeout: 30000,
          },
        ]
      : [];

    const plan: ExecutionPlan = {
      id: planId,
      decisionId: action.decisionId,
      action,
      steps: [step],
      rollbackSteps,
      createdAt: now,
    };

    return plan;
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    this.executedPlans.set(plan.id, plan);
    this.planStatuses.set(plan.id, 'running');

    const result: ExecutionResult = {
      planId: plan.id,
      status: 'running',
      startedAt: new Date(),
    };

    for (const step of plan.steps) {
      const handler = this.registry.getHandler(step.type);

      if (!handler) {
        // Throw (not soft-fail) so the execution router's fallback chain
        // continues to the next adapter (e.g. OpenClaw).
        throw new Error(
          `No handler registered for action type: ${step.type} — falling back to next adapter`,
        );
      }

      const stepResult = await this.executeStepWithTimeout(handler, step);

      if (!stepResult.success) {
        // Step failed — attempt rollback
        result.status = 'failed';
        result.completedAt = new Date();
        result.error = stepResult.error ?? `Step ${step.order} failed`;
        this.planStatuses.set(plan.id, 'failed');

        if (plan.rollbackSteps.length > 0) {
          await this.executeRollbackSteps(plan);
        }

        return result;
      }

      result.output = { ...result.output, ...stepResult.output };
    }

    result.status = 'completed';
    result.completedAt = new Date();
    this.planStatuses.set(plan.id, 'completed');
    return result;
  }

  async *executeStreaming(plan: ExecutionPlan): AsyncIterable<ExecutionEvent> {
    this.executedPlans.set(plan.id, plan);
    this.planStatuses.set(plan.id, 'running');

    yield {
      planId: plan.id,
      eventType: 'plan_started',
      timestamp: new Date(),
      payload: { adapter: 'direct', steps: plan.steps.length },
    };

    const result: ExecutionResult = {
      planId: plan.id,
      status: 'running',
      startedAt: new Date(),
    };

    for (const step of plan.steps) {
      const handler = this.registry.getHandler(step.type);
      if (!handler) {
        throw new Error(
          `No handler registered for action type: ${step.type} — falling back to next adapter`,
        );
      }

      yield {
        planId: plan.id,
        stepId: step.id,
        eventType: 'step_started',
        timestamp: new Date(),
        payload: { type: step.type, order: step.order, description: step.description },
      };

      const stepResult = await this.executeStepWithTimeout(handler, step);
      if (!stepResult.success) {
        result.status = 'failed';
        result.completedAt = new Date();
        result.error = stepResult.error ?? `Step ${step.order} failed`;
        this.planStatuses.set(plan.id, 'failed');

        yield {
          planId: plan.id,
          stepId: step.id,
          eventType: 'step_failed',
          timestamp: new Date(),
          payload: { error: result.error },
        };

        if (plan.rollbackSteps.length > 0) {
          await this.executeRollbackSteps(plan);
        }

        yield {
          planId: plan.id,
          eventType: 'plan_failed',
          timestamp: new Date(),
          payload: { error: result.error },
        };
        return;
      }

      result.output = { ...result.output, ...stepResult.output };
      yield {
        planId: plan.id,
        stepId: step.id,
        eventType: 'step_completed',
        timestamp: new Date(),
        payload: { output: stepResult.output ?? {} },
      };
    }

    this.planStatuses.set(plan.id, 'completed');
    yield {
      planId: plan.id,
      eventType: 'plan_completed',
      timestamp: new Date(),
      payload: { output: result.output ?? {}, adapter: 'direct' },
    };
  }

  async getStatus(planId: string): Promise<ExecutionStatus> {
    const status = this.planStatuses.get(planId);
    if (!status) {
      throw new Error(`No executed plan found for ID: ${planId}`);
    }
    return status;
  }

  async rollback(planId: string): Promise<RollbackResult> {
    const plan = this.executedPlans.get(planId);
    if (!plan) {
      return {
        success: false,
        message: `No executed plan found for ID: ${planId}`,
      };
    }

    if (plan.rollbackSteps.length === 0) {
      return {
        success: false,
        message: 'This action is not reversible. No rollback steps defined.',
      };
    }

    if (!plan.action.reversible) {
      return {
        success: false,
        message: 'The action is marked as irreversible.',
      };
    }

    return this.executeRollbackSteps(plan);
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    const handlers = this.registry.getAllHandlers();
    const latencyMs = Date.now() - start;

    return {
      healthy: handlers.length > 0,
      latencyMs,
    };
  }

  private async executeRollbackSteps(plan: ExecutionPlan): Promise<RollbackResult> {
    const reversedSteps = [...plan.rollbackSteps].reverse();

    for (const step of reversedSteps) {
      const handler = this.registry.getHandler(step.type) ??
        this.registry.getHandler(step.parameters['originalActionType'] as string ?? '');

      if (!handler) {
        return {
          success: false,
          message: `No handler for rollback step: ${step.type}`,
        };
      }

      const stepResult = await handler.rollback(step);
      if (!stepResult.success) {
        return {
          success: false,
          message: `Rollback failed at step ${step.order}: ${stepResult.error}. Manual intervention may be required.`,
        };
      }
    }

    return {
      success: true,
      message: `Successfully rolled back ${reversedSteps.length} step(s).`,
    };
  }

  private async executeStepWithTimeout(
    handler: { execute(step: ExecutionStep): Promise<StepResult> },
    step: ExecutionStep,
  ): Promise<StepResult> {
    const timeoutMs = step.timeout > 0 ? step.timeout : 30_000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        handler.execute(step),
        new Promise<StepResult>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              success: false,
              error: `Step timed out after ${timeoutMs}ms`,
            });
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
