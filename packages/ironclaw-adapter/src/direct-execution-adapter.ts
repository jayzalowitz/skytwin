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
import {
  PreRequestExecutionError,
  type ExecutionPlanBuildContext,
  type ExecutionRequestPreparation,
  type IronClawAdapter,
} from './ironclaw-adapter.js';
import type { ActionHandlerRegistry } from './handler-registry.js';

interface PreparedActionHandler {
  prepareRequestStart?(
    step: ExecutionStep,
    context?: ExecutionPlanBuildContext,
  ): Promise<ExecutionRequestPreparation>;
  execute(step: ExecutionStep, preparation?: ExecutionRequestPreparation): Promise<StepResult>;
}

interface DirectRequestStartProof {
  planId: string;
  streaming: boolean;
  handler: PreparedActionHandler;
  handlerPreparation?: ExecutionRequestPreparation;
}

const DIRECT_INTEGRATION_REQUIRED_ACTIONS = new Set([
  'pay_bill', 'transfer_funds', 'summarize_document', 'schedule_social_post',
  'respond_to_mention', 'share_content', 'assign_task', 'set_thermostat',
  'toggle_lights', 'lock_door', 'set_alarm', 'run_routine', 'book_appointment',
  'reschedule_appointment', 'flag_health_anomaly',
]);

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
  private readonly requestStartProofs = new WeakSet<object>();

  constructor(private readonly registry: ActionHandlerRegistry) {}

  async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
    if (!this.registry.getHandler(action.actionType)) {
      throw new PreRequestExecutionError(
        `No handler registered for action type: ${action.actionType}`,
      );
    }
    if (DIRECT_INTEGRATION_REQUIRED_ACTIONS.has(action.actionType)) {
      throw new PreRequestExecutionError(
        `Direct execution for ${action.actionType} requires an external integration.`,
      );
    }
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

    const handler = this.registry.getHandler(action.actionType);
    const rollbackSteps: ExecutionStep[] = action.reversible && handler?.supportsRollback !== false
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

  async prepareRequestStart(
    plan: ExecutionPlan,
    context?: ExecutionPlanBuildContext,
  ): Promise<ExecutionRequestPreparation> {
    const step = plan.steps[0];
    if (!step) throw new PreRequestExecutionError('Direct execution plan has no executable step.');
    const handler = this.registry.getHandler(step.type) as PreparedActionHandler | null;
    if (!handler) {
      throw new PreRequestExecutionError(`No handler registered for action type: ${step.type}`);
    }
    const handlerPreparation = await handler.prepareRequestStart?.(step, context);
    const proof: DirectRequestStartProof = {
      planId: plan.id,
      streaming: context?.streaming === true,
      handler,
      handlerPreparation,
    };
    this.requestStartProofs.add(proof);
    return {
      proof,
      ...(handlerPreparation?.credentialBinding
        ? { credentialBinding: handlerPreparation.credentialBinding }
        : {}),
    };
  }

  private consumeRequestStartProof(
    plan: ExecutionPlan,
    preparation: ExecutionRequestPreparation | undefined,
    streaming: boolean,
  ): DirectRequestStartProof | undefined {
    if (!preparation) return undefined;
    const proof = preparation?.proof;
    const valid = typeof proof === 'object' && proof !== null &&
      this.requestStartProofs.has(proof) &&
      (proof as DirectRequestStartProof).planId === plan.id &&
      (proof as DirectRequestStartProof).streaming === streaming;
    if (typeof proof === 'object' && proof !== null) this.requestStartProofs.delete(proof);
    if (!valid) throw new Error('Direct request-start preparation proof is invalid or already consumed.');
    return proof as DirectRequestStartProof;
  }

  async execute(
    plan: ExecutionPlan,
    preparation?: ExecutionRequestPreparation,
  ): Promise<ExecutionResult> {
    const prepared = this.consumeRequestStartProof(plan, preparation, false);
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
        throw new PreRequestExecutionError(
          `No handler registered for action type: ${step.type} — falling back to next adapter`,
        );
      }

      if (prepared && handler !== prepared.handler) {
        throw new Error('Direct request-start preparation handler changed before dispatch.');
      }
      const stepResult = await this.executeStepWithTimeout(
        handler as PreparedActionHandler,
        step,
        prepared?.handlerPreparation,
      );

      if (!stepResult.success) {
        // Step failed — attempt rollback
        result.status = 'failed';
        result.completedAt = new Date();
        result.error = stepResult.error ?? `Step ${step.order} failed`;
        this.planStatuses.set(plan.id, 'failed');

        if (plan.rollbackSteps.length > 0) {
          await this.executeRollbackSteps(plan);
        }

        result.output = { ...result.output, rollback_available: plan.rollbackSteps.length > 0 };
        return result;
      }

      result.output = { ...result.output, ...stepResult.output };
    }

    result.output = { ...result.output, rollback_available: plan.rollbackSteps.length > 0 };
    result.status = 'completed';
    result.completedAt = new Date();
    this.planStatuses.set(plan.id, 'completed');
    return result;
  }

  async *executeStreaming(
    plan: ExecutionPlan,
    preparation?: ExecutionRequestPreparation,
  ): AsyncIterable<ExecutionEvent> {
    const prepared = this.consumeRequestStartProof(plan, preparation, true);
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
        throw new PreRequestExecutionError(
          `No handler registered for action type: ${step.type} — falling back to next adapter`,
        );
      }

      if (prepared && handler !== prepared.handler) {
        throw new Error('Direct request-start preparation handler changed before dispatch.');
      }
      const stepResult = await this.executeStepWithTimeout(
        handler as PreparedActionHandler,
        step,
        prepared?.handlerPreparation,
      );
      // The action provider request starts inside executeStepWithTimeout before
      // this generator yields. A yielded progress event must never create a
      // post-lease pause/policy race ahead of the external request boundary.
      yield {
        planId: plan.id,
        eventType: 'plan_started',
        timestamp: new Date(),
        payload: { adapter: 'direct', steps: plan.steps.length },
      };
      yield {
        planId: plan.id,
        stepId: step.id,
        eventType: 'step_started',
        timestamp: new Date(),
        payload: { type: step.type, order: step.order, description: step.description },
      };
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
          payload: { error: result.error, rollback_available: plan.rollbackSteps.length > 0 },
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
      payload: {
        output: result.output ?? {},
        adapter: 'direct',
        rollback_available: plan.rollbackSteps.length > 0,
      },
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
    handler: PreparedActionHandler,
    step: ExecutionStep,
    preparation?: ExecutionRequestPreparation,
  ): Promise<StepResult> {
    const timeoutMs = step.timeout > 0 ? step.timeout : 30_000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        handler.execute(step, preparation),
        new Promise<StepResult>((_resolve, reject) => {
          timer = setTimeout(() => {
            // ActionHandler has no cancellation/settlement contract. The
            // handler may still commit after this timer fires, so timeout is
            // ambiguous rather than a terminal failed StepResult.
            reject(new Error(
              `Step timed out after ${timeoutMs}ms; execution outcome is ambiguous`,
            ));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
