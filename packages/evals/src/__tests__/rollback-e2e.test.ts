import { describe, it, expect, beforeEach } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type { CandidateAction, ExecutionPlan, ExecutionStep } from '@skytwin/shared-types';
import { MockIronClawAdapter } from '@skytwin/ironclaw-adapter';

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action_1',
    decisionId: 'dec_1',
    actionType: 'archive_email',
    description: 'Archive low-priority email',
    domain: 'email',
    parameters: { emailId: 'msg_123' },
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'User consistently archives this sender',
    ...overrides,
  };
}

function makePlan(action: CandidateAction, includeRollback = true): ExecutionPlan {
  const step: ExecutionStep = {
    id: 'step_1',
    order: 1,
    type: action.actionType,
    description: action.description,
    parameters: action.parameters,
    timeout: 30000,
  };

  const rollbackSteps: ExecutionStep[] = includeRollback && action.reversible
    ? [{
        id: 'step_rollback_1',
        order: 1,
        type: `rollback_${action.actionType}`,
        description: `Rollback: ${action.description}`,
        parameters: { ...action.parameters, originalActionType: action.actionType },
        timeout: 30000,
      }]
    : [];

  return {
    id: `plan_${Date.now()}`,
    decisionId: action.decisionId,
    action,
    steps: [step],
    rollbackSteps,
    createdAt: new Date(),
  };
}

describe('Rollback E2E', () => {
  let adapter: MockIronClawAdapter;

  beforeEach(() => {
    adapter = new MockIronClawAdapter({
      failureProbability: 0,
      simulateDelays: false,
    });
  });

  it('executes and successfully rolls back a reversible action', async () => {
    const action = makeAction({ reversible: true });
    const plan = makePlan(action);

    const execResult = await adapter.execute(plan);
    expect(execResult.status).toBe('completed');

    const rollbackResult = await adapter.rollback(plan.id);
    expect(rollbackResult.success).toBe(true);
    expect(rollbackResult.message).toContain('Successfully rolled back');

    const logs = adapter.getLogs();
    const execLogs = logs.filter((l) => l.operation === 'execute');
    const rollbackLogs = logs.filter((l) => l.operation === 'rollback');
    expect(execLogs.length).toBeGreaterThan(0);
    expect(rollbackLogs.length).toBeGreaterThan(0);
  });

  it('refuses to roll back an irreversible action', async () => {
    const action = makeAction({ reversible: false });
    const plan = makePlan(action, false);

    const execResult = await adapter.execute(plan);
    expect(execResult.status).toBe('completed');

    const rollbackResult = await adapter.rollback(plan.id);
    expect(rollbackResult.success).toBe(false);
    expect(rollbackResult.message).toContain('not reversible');
  });

  it('refuses to roll back a plan that was never executed', async () => {
    const rollbackResult = await adapter.rollback('plan_nonexistent');
    expect(rollbackResult.success).toBe(false);
    expect(rollbackResult.message).toContain('No execution plan found');
  });

  it('handles execution failure gracefully', async () => {
    const failAdapter = new MockIronClawAdapter({
      failureProbability: 1.0, // Always fail
      simulateDelays: false,
    });

    const action = makeAction();
    const plan = makePlan(action);

    const result = await failAdapter.execute(plan);
    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });

  it('tracks execution lifecycle through operation logs', async () => {
    const action = makeAction();
    const plan = makePlan(action);

    await adapter.execute(plan);
    await adapter.getStatus(plan.id);
    await adapter.rollback(plan.id);

    const logs = adapter.getLogs();
    const operations = logs.map((l) => l.operation);
    expect(operations).toContain('execute');
    expect(operations).toContain('status_check');
    expect(operations).toContain('rollback');
  });

  it('reports unhealthy when configured', async () => {
    expect(await adapter.healthCheck()).toBe(true);
    adapter.setHealthy(false);
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('resets all state cleanly', async () => {
    const action = makeAction();
    const plan = makePlan(action);

    await adapter.execute(plan);
    expect(adapter.getLogs().length).toBeGreaterThan(0);

    adapter.reset();
    expect(adapter.getLogs().length).toBe(0);
    expect(adapter.getResult(plan.id)).toBeUndefined();
  });
});
