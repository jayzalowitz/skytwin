import { describe, it, expect, beforeEach } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type { CandidateAction, ExecutionPlan, ExecutionStep } from '@skytwin/shared-types';
import { MockIronClawAdapter } from '../mock-adapter.js';

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action-rollback-1',
    decisionId: 'decision-rollback-1',
    actionType: 'send_email',
    description: 'Send a test email for rollback testing',
    domain: 'email',
    parameters: { to: 'test@example.com', subject: 'Rollback Test' },
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Test rollback',
    ...overrides,
  };
}

function buildPlan(action: CandidateAction): ExecutionPlan {
  const planId = `plan_test_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const step: ExecutionStep = {
    id: `step_${planId}_1`,
    order: 1,
    type: action.actionType,
    description: action.description,
    parameters: action.parameters,
    timeout: 30000,
  };

  const rollbackSteps: ExecutionStep[] = action.reversible
    ? [{
        id: `step_${planId}_rollback_1`,
        order: 1,
        type: `rollback_${action.actionType}`,
        description: `Rollback: ${action.description}`,
        parameters: { ...action.parameters, originalActionType: action.actionType },
        timeout: 30000,
      }]
    : [];

  return {
    id: planId,
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
      simulateDelays: false,
      failureProbability: 0,
    });
  });

  it('execute then rollback succeeds for reversible action', async () => {
    const action = makeAction({ reversible: true });
    const plan = buildPlan(action);

    // Execute
    const execResult = await adapter.execute(plan);
    expect(execResult.status).toBe('completed');
    expect(execResult.planId).toBe(plan.id);

    // Rollback
    const rollbackResult = await adapter.rollback(plan.id);
    expect(rollbackResult.success).toBe(true);
    expect(rollbackResult.message).toContain('rolled back');

    // Verify execution state was updated
    const finalResult = adapter.getResult(plan.id);
    expect(finalResult).toBeDefined();
    expect(finalResult!.output?.['rolledBack']).toBe(true);
  });

  it('rollback fails for irreversible action', async () => {
    const action = makeAction({ reversible: false });
    const plan = buildPlan(action);

    // Execute
    const execResult = await adapter.execute(plan);
    expect(execResult.status).toBe('completed');

    // Rollback should fail
    const rollbackResult = await adapter.rollback(plan.id);
    expect(rollbackResult.success).toBe(false);
    expect(rollbackResult.message).toContain('not reversible');
  });

  it('rollback fails for unknown plan', async () => {
    const result = await adapter.rollback('nonexistent-plan-id');
    expect(result.success).toBe(false);
    expect(result.message).toContain('No execution');
  });

  it('rollback fails for unexecuted plan', async () => {
    const result = await adapter.rollback('never-executed-plan');
    expect(result.success).toBe(false);
  });

  it('operation log records execute and rollback', async () => {
    const action = makeAction({ reversible: true });
    const plan = buildPlan(action);

    await adapter.execute(plan);
    await adapter.rollback(plan.id);

    const logs = adapter.getLogs();
    const operations = logs.map((l) => l.operation);

    expect(operations).toContain('execute');
    expect(operations).toContain('rollback');

    // Execute logs
    const execLogs = logs.filter((l) => l.operation === 'execute');
    expect(execLogs.length).toBeGreaterThanOrEqual(1);
    expect(execLogs.some((l) => l.result === 'completed successfully')).toBe(true);

    // Rollback logs
    const rollbackLogs = logs.filter((l) => l.operation === 'rollback');
    expect(rollbackLogs.length).toBeGreaterThanOrEqual(1);
    expect(rollbackLogs.some((l) => l.result === 'completed successfully')).toBe(true);
  });

  it('multiple executions can each be rolled back independently', async () => {
    const action1 = makeAction({ id: 'action-1', decisionId: 'dec-1' });
    const action2 = makeAction({ id: 'action-2', decisionId: 'dec-2' });

    const plan1 = buildPlan(action1);
    const plan2 = buildPlan(action2);

    await adapter.execute(plan1);
    await adapter.execute(plan2);

    // Rollback plan2 only
    const result2 = await adapter.rollback(plan2.id);
    expect(result2.success).toBe(true);

    // plan1 should still be in completed (not rolled back) state
    const plan1Result = adapter.getResult(plan1.id);
    expect(plan1Result!.output?.['rolledBack']).toBeUndefined();

    // plan2 should be rolled back
    const plan2Result = adapter.getResult(plan2.id);
    expect(plan2Result!.output?.['rolledBack']).toBe(true);

    // Now rollback plan1
    const result1 = await adapter.rollback(plan1.id);
    expect(result1.success).toBe(true);
  });
});
