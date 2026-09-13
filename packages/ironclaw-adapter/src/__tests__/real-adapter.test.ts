import { describe, it, expect } from 'vitest';
import { DirectExecutionAdapter } from '../direct-execution-adapter.js';
import { ActionHandlerRegistry } from '../handler-registry.js';
import type { CandidateAction, ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

/** Test handler that always succeeds for test_action type. */
class TestActionHandler implements ActionHandler {
  readonly actionType = 'test_action';
  readonly domain = 'testing';
  canHandle(actionType: string): boolean { return actionType === 'test_action'; }
  async execute(_step: ExecutionStep): Promise<StepResult> {
    return { success: true, output: { test: true } };
  }
  async rollback(_step: ExecutionStep): Promise<StepResult> {
    return { success: true, output: { rollback: true } };
  }
}

class NoRollbackActionHandler extends TestActionHandler {
  readonly supportsRollback = false;
}

class SlowActionHandler implements ActionHandler {
  readonly actionType = 'test_action';
  readonly domain = 'testing';
  committed = false;
  canHandle(actionType: string): boolean { return actionType === 'test_action'; }
  async execute(_step: ExecutionStep): Promise<StepResult> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.committed = true;
    return { success: true };
  }
  async rollback(_step: ExecutionStep): Promise<StepResult> {
    return { success: true };
  }
}

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'act_1',
    decisionId: 'dec_1',
    actionType: 'test_action',
    description: 'Test action',
    domain: 'test',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Test',
    ...overrides,
  };
}

describe('DirectExecutionAdapter', () => {
  it('builds a plan from a candidate action', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const action = makeAction();
    const plan = await adapter.buildPlan(action);

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.type).toBe('test_action');
    expect(plan.rollbackSteps).toHaveLength(1); // reversible action
  });

  it('does not create rollback steps for irreversible actions', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const action = makeAction({ reversible: false });
    const plan = await adapter.buildPlan(action);

    expect(plan.rollbackSteps).toHaveLength(0);
  });

  it('does not advertise rollback when the selected handler lacks rollback authority', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new NoRollbackActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction({ reversible: true }));
    expect(plan.rollbackSteps).toEqual([]);
    const result = await adapter.execute(plan);
    expect(result.output?.['rollback_available']).toBe(false);
    await expect(adapter.rollback(plan.id)).resolves.toMatchObject({ success: false });
  });

  it('executes a plan using the handler', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    const result = await adapter.execute(plan);

    expect(result.status).toBe('completed');
    expect(result.output).toBeDefined();
  });

  it('tracks execution status for completed plans', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    await adapter.execute(plan);

    await expect(adapter.getStatus(plan.id)).resolves.toBe('completed');
    await expect(adapter.getStatus('missing-plan')).rejects.toThrow('No executed plan');
  });

  it('streams per-step execution events', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    const events: string[] = [];
    for await (const event of adapter.executeStreaming(plan)) {
      events.push(event.eventType);
    }

    expect(events).toEqual(['plan_started', 'step_started', 'step_completed', 'plan_completed']);
  });

  it('leaves a timed-out handler ambiguous when it can still commit later', async () => {
    const registry = new ActionHandlerRegistry();
    const handler = new SlowActionHandler();
    registry.register(handler);
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    plan.steps[0]!.timeout = 5;

    await expect(adapter.execute(plan)).rejects.toThrow('outcome is ambiguous');
    await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handler.committed).toBe(true);
    await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
  });

  it('throws when no handler is registered (enables fallback chain)', async () => {
    const registry = new ActionHandlerRegistry(); // empty
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    await expect(adapter.execute(plan)).rejects.toThrow('No handler');
  });

  it('supports rollback for executed plans', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    await adapter.execute(plan);

    const rollbackResult = await adapter.rollback(plan.id);
    expect(rollbackResult.success).toBe(true);
  });

  it('healthCheck returns healthy when handlers are registered', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(true);
  });

  it('healthCheck returns unhealthy when no handlers', async () => {
    const registry = new ActionHandlerRegistry();
    const adapter = new DirectExecutionAdapter(registry);

    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
  });
});
