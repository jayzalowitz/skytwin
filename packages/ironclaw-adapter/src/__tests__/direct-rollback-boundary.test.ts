import { describe, expect, it } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type {
  ActionHandler,
  CandidateAction,
  ExecutionPlan,
  ExecutionStep,
  StepResult,
} from '@skytwin/shared-types';
import { ActionHandlerRegistry } from '../handler-registry.js';
import { DirectExecutionAdapter } from '../direct-execution-adapter.js';

class OrderedHandler implements ActionHandler {
  readonly actionType = 'ordered';
  readonly domain = 'test';
  readonly executed: number[] = [];
  readonly rolledBack: number[] = [];

  constructor(
    private readonly failedOrder?: number,
    private readonly failureMode: 'soft' | 'throw' | 'timeout' = 'soft',
  ) {}

  canHandle(actionType: string): boolean {
    return actionType === 'ordered' || actionType === 'rollback_ordered';
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    this.executed.push(step.order);
    if (step.order !== this.failedOrder) return { success: true };
    if (this.failureMode === 'throw') throw new Error('ambiguous failure');
    if (this.failureMode === 'timeout') return new Promise<StepResult>(() => {});
    return { success: false, error: 'expected failure' };
  }

  async rollback(step: ExecutionStep): Promise<StepResult> {
    this.rolledBack.push(step.order);
    return { success: true };
  }
}

function plan(): ExecutionPlan {
  const action: CandidateAction = {
    id: 'action',
    decisionId: 'decision',
    actionType: 'ordered',
    description: 'ordered plan',
    domain: 'test',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'test',
  };
  const steps = [1, 2, 3].map((order): ExecutionStep => ({
    id: `step-${order}`,
    order,
    type: 'ordered',
    description: `step ${order}`,
    parameters: {},
    timeout: 1_000,
  }));
  return {
    id: 'plan',
    decisionId: action.decisionId,
    action,
    steps,
    rollbackSteps: steps.map((step) => ({
      ...step,
      id: `rollback-${step.order}`,
      type: 'rollback_ordered',
      parameters: { originalActionType: 'ordered' },
    })),
    createdAt: new Date(),
  };
}

function adapter(handler: OrderedHandler): DirectExecutionAdapter {
  const registry = new ActionHandlerRegistry();
  registry.register(handler);
  return new DirectExecutionAdapter(registry);
}

describe('DirectExecutionAdapter rollback boundary', () => {
  it('compensates only successfully completed steps before a failed step', async () => {
    const handler = new OrderedHandler(2);
    const result = await adapter(handler).execute(plan());

    expect(result.status).toBe('failed');
    expect(handler.executed).toEqual([1, 2]);
    expect(handler.rolledBack).toEqual([1]);
  });

  it('does not compensate the first failed step or any unexecuted step', async () => {
    const handler = new OrderedHandler(1);
    const result = await adapter(handler).execute(plan());

    expect(result.status).toBe('failed');
    expect(handler.executed).toEqual([1]);
    expect(handler.rolledBack).toEqual([]);
  });

  it.each(['throw', 'timeout'] as const)(
    'does not compensate after a step %s because its effect is ambiguous',
    async (failureMode) => {
      const handler = new OrderedHandler(2, failureMode);
      const direct = adapter(handler);
      const value = plan();
      value.steps[1]!.timeout = 1;

      await expect(direct.execute(value)).rejects.toThrow();
      expect(handler.executed).toEqual([1, 2]);
      expect(handler.rolledBack).toEqual([]);
    },
  );

  it('does not compensate when a later step has no handler', async () => {
    const handler = new OrderedHandler();
    const direct = adapter(handler);
    const value = plan();
    value.steps[1]!.type = 'missing';

    await expect(direct.execute(value)).rejects.toThrow('No handler');
    expect(handler.executed).toEqual([1]);
    expect(handler.rolledBack).toEqual([]);
  });

  it.each(['throw', 'timeout'] as const)(
    'does not compensate during streaming after a step %s',
    async (failureMode) => {
      const handler = new OrderedHandler(2, failureMode);
      const direct = adapter(handler);
      const value = plan();
      value.steps[1]!.timeout = 1;

      const consume = async () => {
        for await (const _event of direct.executeStreaming(value)) {
          // Drain the stream until the ambiguous failure surfaces.
        }
      };
      await expect(consume()).rejects.toThrow();
      expect(handler.executed).toEqual([1, 2]);
      expect(handler.rolledBack).toEqual([]);
    },
  );

  it('does not compensate during streaming when a later handler is missing', async () => {
    const handler = new OrderedHandler();
    const direct = adapter(handler);
    const value = plan();
    value.steps[1]!.type = 'missing';

    const consume = async () => {
      for await (const _event of direct.executeStreaming(value)) {
        // Drain the stream until the missing handler surfaces.
      }
    };
    await expect(consume()).rejects.toThrow('No handler');
    expect(handler.executed).toEqual([1]);
    expect(handler.rolledBack).toEqual([]);
  });

  it('applies the same completed-step boundary to streaming execution', async () => {
    const handler = new OrderedHandler(3);
    const events = [];
    for await (const event of adapter(handler).executeStreaming(plan())) events.push(event.eventType);

    expect(events.at(-1)).toBe('plan_failed');
    expect(handler.executed).toEqual([1, 2, 3]);
    expect(handler.rolledBack).toEqual([2, 1]);
  });

  it('manual rollback compensates completed steps in reverse order only once', async () => {
    const handler = new OrderedHandler();
    const direct = adapter(handler);
    await direct.execute(plan());

    await expect(direct.rollback('plan')).resolves.toMatchObject({ success: true });
    expect(handler.rolledBack).toEqual([3, 2, 1]);
    await expect(direct.rollback('plan')).resolves.toMatchObject({ success: false });
    expect(handler.rolledBack).toEqual([3, 2, 1]);
  });
});
