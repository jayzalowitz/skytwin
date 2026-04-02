import { describe, it, expect } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type { CandidateAction, ExecutionPlan, ExecutionStep } from '@skytwin/shared-types';
import { MockIronClawAdapter, DirectExecutionAdapter, ActionHandlerRegistry, GenericActionHandler } from '@skytwin/ironclaw-adapter';

/**
 * Contract tests: verify that both MockIronClawAdapter and DirectExecutionAdapter
 * satisfy the IronClawAdapter interface contract identically. These tests run
 * the same assertions against both implementations to ensure behavioral parity.
 */

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action_1',
    decisionId: 'dec_1',
    actionType: 'test_action',
    description: 'Test action for contract verification',
    domain: 'testing',
    parameters: { key: 'value' },
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Contract test',
    ...overrides,
  };
}

function makePlan(action: CandidateAction, withRollback = true): ExecutionPlan {
  const step: ExecutionStep = {
    id: 'step_1',
    order: 1,
    type: action.actionType,
    description: action.description,
    parameters: { ...action.parameters, actionType: action.actionType },
    timeout: 30000,
  };

  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    decisionId: action.decisionId,
    action,
    steps: [step],
    rollbackSteps: withRollback && action.reversible
      ? [{
          id: 'step_rollback_1',
          order: 1,
          type: `rollback_${action.actionType}`,
          description: `Rollback: ${action.description}`,
          parameters: { ...action.parameters, originalActionType: action.actionType },
          timeout: 30000,
        }]
      : [],
    createdAt: new Date(),
  };
}

function createAdapters(): Array<{ name: string; adapter: MockIronClawAdapter | DirectExecutionAdapter }> {
  const registry = new ActionHandlerRegistry();
  registry.register(new GenericActionHandler());

  return [
    { name: 'MockIronClawAdapter', adapter: new MockIronClawAdapter({ failureProbability: 0, simulateDelays: false }) },
    { name: 'DirectExecutionAdapter', adapter: new DirectExecutionAdapter(registry) },
  ];
}

describe('IronClaw Adapter Contract', () => {
  for (const { name, adapter } of createAdapters()) {
    describe(`${name}`, () => {
      it('execute() returns completed status on success', async () => {
        const action = makeAction();
        const plan = makePlan(action);

        const result = await adapter.execute(plan);
        expect(result.planId).toBe(plan.id);
        expect(result.status).toBe('completed');
        expect(result.startedAt).toBeInstanceOf(Date);
        expect(result.completedAt).toBeInstanceOf(Date);
        expect(result.error).toBeUndefined();
      });

      it('execute() returns result with output on success', async () => {
        const action = makeAction();
        const plan = makePlan(action);

        const result = await adapter.execute(plan);
        expect(result.output).toBeDefined();
        expect(typeof result.output).toBe('object');
      });

      it('rollback() succeeds for reversible actions', async () => {
        const action = makeAction({ reversible: true });
        const plan = makePlan(action);

        await adapter.execute(plan);
        const rollbackResult = await adapter.rollback(plan.id);
        expect(rollbackResult.success).toBe(true);
        expect(typeof rollbackResult.message).toBe('string');
        expect(rollbackResult.message.length).toBeGreaterThan(0);
      });

      it('rollback() fails for irreversible actions', async () => {
        const action = makeAction({ reversible: false });
        const plan = makePlan(action, false);

        await adapter.execute(plan);
        const rollbackResult = await adapter.rollback(plan.id);
        expect(rollbackResult.success).toBe(false);
        expect(typeof rollbackResult.message).toBe('string');
      });

      it('rollback() fails for unknown plan IDs', async () => {
        const rollbackResult = await adapter.rollback('plan_unknown_xyz');
        expect(rollbackResult.success).toBe(false);
      });

      it('healthCheck() returns a result', async () => {
        const result = await adapter.healthCheck();
        // MockIronClawAdapter returns boolean, DirectExecutionAdapter returns { healthy, latencyMs }
        // Both should be truthy
        if (typeof result === 'boolean') {
          expect(result).toBe(true);
        } else {
          expect(result.healthy).toBe(true);
          expect(typeof result.latencyMs).toBe('number');
        }
      });

      it('execute() sets planId matching the input plan', async () => {
        const action = makeAction();
        const plan = makePlan(action);

        const result = await adapter.execute(plan);
        expect(result.planId).toBe(plan.id);
      });

      it('execute() with multi-step plan completes all steps', async () => {
        const action = makeAction();
        const plan: ExecutionPlan = {
          ...makePlan(action),
          steps: [
            { id: 'step_1', order: 1, type: 'test_action', description: 'Step 1', parameters: { actionType: 'test_action' }, timeout: 30000 },
            { id: 'step_2', order: 2, type: 'test_action', description: 'Step 2', parameters: { actionType: 'test_action' }, timeout: 30000 },
          ],
        };

        const result = await adapter.execute(plan);
        expect(result.status).toBe('completed');
      });
    });
  }
});

describe('Adapter-Specific Behavior', () => {
  describe('MockIronClawAdapter', () => {
    it('buildPlan() creates valid execution plans', async () => {
      // MockIronClawAdapter implements IronClawExecutor which doesn't have buildPlan
      // but it tracks plans internally via execute()
      const adapter = new MockIronClawAdapter({ failureProbability: 0, simulateDelays: false });
      const action = makeAction();
      const plan = makePlan(action);

      await adapter.execute(plan);
      const storedResult = adapter.getResult(plan.id);
      expect(storedResult).toBeDefined();
      expect(storedResult!.status).toBe('completed');
    });

    it('getStatus() tracks execution state', async () => {
      const adapter = new MockIronClawAdapter({ failureProbability: 0, simulateDelays: false });
      const plan = makePlan(makeAction());

      await adapter.execute(plan);
      const status = await adapter.getStatus(plan.id);
      expect(status).toBe('completed');
    });

    it('getStatus() throws for unknown plans', async () => {
      const adapter = new MockIronClawAdapter({ failureProbability: 0, simulateDelays: false });
      await expect(adapter.getStatus('plan_nope')).rejects.toThrow();
    });
  });

  describe('DirectExecutionAdapter', () => {
    it('buildPlan() creates plan with rollback steps for reversible actions', async () => {
      const registry = new ActionHandlerRegistry();
      registry.register(new GenericActionHandler());
      const adapter = new DirectExecutionAdapter(registry);

      const action = makeAction({ reversible: true });
      const plan = await adapter.buildPlan(action);

      expect(plan.id).toBeDefined();
      expect(plan.decisionId).toBe(action.decisionId);
      expect(plan.steps.length).toBe(1);
      expect(plan.rollbackSteps.length).toBe(1);
      expect(plan.rollbackSteps[0]!.type).toContain('rollback_');
    });

    it('buildPlan() creates plan without rollback steps for irreversible actions', async () => {
      const registry = new ActionHandlerRegistry();
      registry.register(new GenericActionHandler());
      const adapter = new DirectExecutionAdapter(registry);

      const action = makeAction({ reversible: false });
      const plan = await adapter.buildPlan(action);

      expect(plan.rollbackSteps).toHaveLength(0);
    });

    it('execute() fails when no handler is registered', async () => {
      const emptyRegistry = new ActionHandlerRegistry();
      const adapter = new DirectExecutionAdapter(emptyRegistry);

      const action = makeAction({ actionType: 'unknown_action' });
      const plan = makePlan(action);

      const result = await adapter.execute(plan);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('No handler');
    });

    it('healthCheck() reports unhealthy with no handlers', async () => {
      const emptyRegistry = new ActionHandlerRegistry();
      const adapter = new DirectExecutionAdapter(emptyRegistry);

      const health = await adapter.healthCheck();
      expect(health.healthy).toBe(false);
    });
  });
});
