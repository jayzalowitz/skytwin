import { describe, it, expect } from 'vitest';
import { RealIronClawAdapter } from '../real-adapter.js';
import { ActionHandlerRegistry } from '../handler-registry.js';
import { GenericActionHandler } from '../handlers/generic-action-handler.js';
import type { CandidateAction } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

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

describe('RealIronClawAdapter', () => {
  it('builds a plan from a candidate action', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new GenericActionHandler());
    const adapter = new RealIronClawAdapter(registry);

    const action = makeAction();
    const plan = await adapter.buildPlan(action);

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.type).toBe('test_action');
    expect(plan.rollbackSteps).toHaveLength(1); // reversible action
  });

  it('does not create rollback steps for irreversible actions', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new GenericActionHandler());
    const adapter = new RealIronClawAdapter(registry);

    const action = makeAction({ reversible: false });
    const plan = await adapter.buildPlan(action);

    expect(plan.rollbackSteps).toHaveLength(0);
  });

  it('executes a plan using the handler', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new GenericActionHandler());
    const adapter = new RealIronClawAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    const result = await adapter.execute(plan);

    expect(result.status).toBe('completed');
    expect(result.output).toBeDefined();
  });

  it('fails execution when no handler is registered', async () => {
    const registry = new ActionHandlerRegistry(); // empty
    const adapter = new RealIronClawAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    const result = await adapter.execute(plan);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No handler registered');
  });

  it('supports rollback for executed plans', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new GenericActionHandler());
    const adapter = new RealIronClawAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    await adapter.execute(plan);

    const rollbackResult = await adapter.rollback(plan.id);
    expect(rollbackResult.success).toBe(true);
  });

  it('healthCheck returns healthy when handlers are registered', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new GenericActionHandler());
    const adapter = new RealIronClawAdapter(registry);

    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(true);
  });

  it('healthCheck returns unhealthy when no handlers', async () => {
    const registry = new ActionHandlerRegistry();
    const adapter = new RealIronClawAdapter(registry);

    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
  });
});
