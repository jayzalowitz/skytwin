import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ConfidenceLevel,
  RiskDimension,
  RiskTier,
  type CandidateAction,
  type ExecutionPlan,
  type ExecutionResult,
  type RiskAssessment,
  type RollbackResult,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import {
  AdapterRegistry,
  DIRECT_TRUST_PROFILE,
  OPENCLAW_TRUST_PROFILE,
} from '../adapter-registry.js';
import {
  ExecutionRouter,
  InvariantViolationError,
  type PreparedExecution,
} from '../execution-router.js';

function action(actionType = 'label_email', parameters: Record<string, unknown> = {}): CandidateAction {
  return {
    id: 'action-1', decisionId: 'decision-1', actionType,
    description: 'Test action', domain: 'email', parameters,
    estimatedCostCents: 0, reversible: true, confidence: ConfidenceLevel.HIGH,
    reasoning: 'test', provenance: 'user_originated',
  };
}

function risk(): RiskAssessment {
  const dimension = { tier: RiskTier.LOW, score: 0.1, reasoning: 'low' };
  return {
    actionId: 'action-1', overallTier: RiskTier.LOW,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: dimension,
      [RiskDimension.FINANCIAL_IMPACT]: dimension,
      [RiskDimension.LEGAL_SENSITIVITY]: dimension,
      [RiskDimension.PRIVACY_SENSITIVITY]: dimension,
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: dimension,
      [RiskDimension.OPERATIONAL_RISK]: dimension,
    },
    reasoning: 'low', assessedAt: new Date(),
  };
}

function statefulActionType(safeDescriptorReads: number): CandidateAction {
  const target = action();
  let actionTypeDescriptorReads = 0;
  return new Proxy(target, {
    get(current, property, receiver) {
      if (property === 'actionType' && actionTypeDescriptorReads > safeDescriptorReads) {
        return 'archive_email';
      }
      return Reflect.get(current, property, receiver) as unknown;
    },
    getOwnPropertyDescriptor(current, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
      if (property !== 'actionType' || !descriptor) return descriptor;
      actionTypeDescriptorReads += 1;
      return {
        ...descriptor,
        value: actionTypeDescriptorReads <= safeDescriptorReads
          ? 'label_email'
          : 'archive_email',
      };
    },
  });
}

describe('ExecutionRouter Gmail archive quarantine', () => {
  let router: ExecutionRouter;
  let buildPlan: Mock<IronClawAdapter['buildPlan']>;
  let execute: Mock<IronClawAdapter['execute']>;
  let fallbackBuildPlan: Mock<IronClawAdapter['buildPlan']>;
  let fallbackExecute: Mock<IronClawAdapter['execute']>;

  beforeEach(() => {
    buildPlan = vi.fn(async (candidate: CandidateAction): Promise<ExecutionPlan> => ({
      id: 'plan-1', decisionId: candidate.decisionId, action: candidate,
      steps: [], rollbackSteps: [], createdAt: new Date(),
    }));
    execute = vi.fn(async (plan: ExecutionPlan): Promise<ExecutionResult> => ({
      planId: plan.id, status: 'completed', startedAt: new Date(),
      completedAt: new Date(), output: {},
    }));
    fallbackBuildPlan = vi.fn(async (candidate: CandidateAction): Promise<ExecutionPlan> => ({
      id: 'fallback-plan', decisionId: candidate.decisionId, action: candidate,
      steps: [], rollbackSteps: [], createdAt: new Date(),
    }));
    fallbackExecute = vi.fn(async (plan: ExecutionPlan): Promise<ExecutionResult> => ({
      planId: plan.id, status: 'completed', startedAt: new Date(),
      completedAt: new Date(), output: {},
    }));
    const adapter: IronClawAdapter = {
      buildPlan,
      execute,
      async getStatus() { return 'completed'; },
      async rollback(): Promise<RollbackResult> { return { success: true, message: 'ok' }; },
      async healthCheck() { return { healthy: true, latencyMs: 1 }; },
    };
    const registry = new AdapterRegistry();
    registry.register('direct', adapter, DIRECT_TRUST_PROFILE, new Set([
      'archive_email', 'label_email',
    ]));
    registry.register('openclaw', {
      ...adapter,
      buildPlan: fallbackBuildPlan,
      execute: fallbackExecute,
    }, OPENCLAW_TRUST_PROFILE, new Set(['archive_email', 'label_email']));
    router = new ExecutionRouter(registry);
  });

  it.each([
    {},
    { emailId: 'legacy-provider-id' },
    { schema: 'gmail_inbox_mutation_v1', messageRefId: 'opaque', operation: 'archive' },
    { schema: 'mixed', operation: 'restore', unrelated: true },
  ])('rejects every archive parameter shape from route: %o', async (parameters) => {
    await expect(router.route(action('archive_email', parameters), risk(), 'user-1'))
      .rejects.toThrow('reserved for its dedicated execution lifecycle');
    expect(buildPlan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fallbackBuildPlan).not.toHaveBeenCalled();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });

  it('rejects an approved executeWithRouting call before adapter work', async () => {
    await expect(router.executeWithRouting(
      action('archive_email'), risk(), 'user-1', { approved: true },
    )).rejects.toBeInstanceOf(InvariantViolationError);
    expect(buildPlan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fallbackBuildPlan).not.toHaveBeenCalled();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });

  it('rechecks the detached route action after a stateful proxy changes its descriptor', async () => {
    await expect(router.route(statefulActionType(1), risk(), 'user-1'))
      .rejects.toThrow('reserved for its dedicated execution lifecycle');
    expect(buildPlan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fallbackBuildPlan).not.toHaveBeenCalled();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });

  it('rejects streaming before yielding or invoking an adapter', async () => {
    await expect(async () => {
      for await (const _event of router.executeWithRoutingStreaming(
        action('archive_email'), risk(), 'user-1', { approved: true },
      )) {
        throw new Error('must not yield');
      }
    }).rejects.toBeInstanceOf(InvariantViolationError);
    expect(buildPlan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fallbackBuildPlan).not.toHaveBeenCalled();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });

  it('rejects preparation without consuming an unrelated issued route', async () => {
    const safeAction = action();
    const issuedRoute = await router.route(safeAction, risk(), 'user-1');
    await expect(router.prepareExecution(
      action('archive_email'), issuedRoute, 'user-1', { approved: true },
    )).rejects.toBeInstanceOf(InvariantViolationError);
    expect(buildPlan).not.toHaveBeenCalled();
    expect(fallbackBuildPlan).not.toHaveBeenCalled();

    await expect(router.prepareExecution(safeAction, issuedRoute, 'user-1'))
      .resolves.toMatchObject({ selectedAdapter: 'direct' });
    expect(buildPlan).toHaveBeenCalledTimes(1);
  });

  it('rechecks the detached prepared action before consuming the issued route', async () => {
    const safeAction = action();
    const issuedRoute = await router.route(safeAction, risk(), 'user-1');

    await expect(router.prepareExecution(
      statefulActionType(2), issuedRoute, 'user-1', { approved: true },
    )).rejects.toThrow('reserved for its dedicated execution lifecycle');
    expect(buildPlan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fallbackBuildPlan).not.toHaveBeenCalled();
    expect(fallbackExecute).not.toHaveBeenCalled();

    await expect(router.prepareExecution(safeAction, issuedRoute, 'user-1'))
      .resolves.toMatchObject({ selectedAdapter: 'direct' });
    expect(buildPlan).toHaveBeenCalledTimes(1);
  });

  it('checks the bound plan action again inside executePrepared', async () => {
    const fabricated = Object.freeze({}) as PreparedExecution;
    const internals = router as unknown as {
      preparedExecutions: WeakMap<object, { plan: { action: CandidateAction } }>;
    };
    internals.preparedExecutions.set(fabricated, {
      plan: { action: action('archive_email') },
    });

    await expect(router.executePrepared(fabricated, 'user-1'))
      .rejects.toThrow('reserved for its dedicated execution lifecycle');
    expect(execute).not.toHaveBeenCalled();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });

  it('fails closed on a hostile action without invoking its getter or adapters', async () => {
    const getter = vi.fn(() => 'archive_email');
    const hostile = Object.defineProperty({}, 'actionType', {
      enumerable: true,
      get: getter,
    }) as unknown as CandidateAction;
    await expect(router.executeWithRouting(hostile, risk(), 'user-1', { approved: true }))
      .rejects.toThrow('could not be inspected safely');
    expect(getter).not.toHaveBeenCalled();
    expect(buildPlan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fallbackBuildPlan).not.toHaveBeenCalled();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });

  it('preserves the established missing CandidateAction invariant before classification', async () => {
    await expect(router.executeWithRouting(
      null as unknown as CandidateAction,
      risk(),
      'user-1',
      { approved: true },
    )).rejects.toThrow('ExecutionRouter called without a CandidateAction.');
    expect(buildPlan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fallbackBuildPlan).not.toHaveBeenCalled();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });

  it('does not affect an unrelated email action', async () => {
    await expect(router.executeWithRouting(action(), risk(), 'user-1'))
      .resolves.toMatchObject({ status: 'completed' });
    expect(buildPlan).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fallbackBuildPlan).not.toHaveBeenCalled();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });
});
