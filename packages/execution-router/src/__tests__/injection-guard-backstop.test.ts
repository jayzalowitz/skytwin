import { describe, it, expect, beforeEach } from 'vitest';
import { RiskTier, ConfidenceLevel, RiskDimension } from '@skytwin/shared-types';
import type {
  CandidateAction,
  RiskAssessment,
  ExecutionPlan,
  ExecutionResult,
  RollbackResult,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import { ExecutionRouter, InvariantViolationError } from '../execution-router.js';
import { AdapterRegistry, DIRECT_TRUST_PROFILE } from '../adapter-registry.js';

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    actionType: 'archive_email',
    description: 'Archive an email',
    domain: 'email',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Test',
    provenance: 'user_originated',
    ...overrides,
  };
}

function makeRisk(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  const dim = { tier: RiskTier.LOW, score: 0.1, reasoning: 'low' };
  return {
    actionId: 'action-1',
    overallTier: RiskTier.LOW,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: dim,
      [RiskDimension.FINANCIAL_IMPACT]: dim,
      [RiskDimension.LEGAL_SENSITIVITY]: dim,
      [RiskDimension.PRIVACY_SENSITIVITY]: dim,
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: dim,
      [RiskDimension.OPERATIONAL_RISK]: dim,
    },
    reasoning: 'low risk',
    assessedAt: new Date(),
    ...overrides,
  };
}

function okAdapter(name: string): IronClawAdapter {
  return {
    async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
      return {
        id: `${name}_plan`,
        decisionId: action.decisionId,
        action,
        steps: [],
        rollbackSteps: [],
        createdAt: new Date(),
      };
    },
    async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
      return {
        planId: plan.id,
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        output: { adapter_used: name },
      };
    },
    async getStatus() {
      return 'completed' as const;
    },
    async rollback(): Promise<RollbackResult> {
      return { success: true, message: 'rolled back' };
    },
    async healthCheck() {
      return { healthy: true, latencyMs: 1 };
    },
  };
}

describe('ExecutionRouter — injection-guard backstop', () => {
  let registry: AdapterRegistry;
  let router: ExecutionRouter;

  beforeEach(() => {
    registry = new AdapterRegistry();
    registry.register('direct', okAdapter('direct'), DIRECT_TRUST_PROFILE);
    router = new ExecutionRouter(registry);
  });

  it('executes a benign action on the auto-execute path (no context)', async () => {
    const action = makeAction();
    const result = await router.executeWithRouting(action, makeRisk(), 'user-1');
    expect(result.status).toBe('completed');
  });

  it('refuses an extreme-severity action on the auto-execute path', async () => {
    const action = makeAction({
      id: 'action-2',
      actionType: 'shell_exec',
      reversible: false,
    });
    await expect(
      router.executeWithRouting(action, makeRisk({ actionId: 'action-2' }), 'user-1'),
    ).rejects.toThrow(InvariantViolationError);
  });

  it('refuses a destructive-severity action on the auto-execute path', async () => {
    const action = makeAction({ id: 'action-3', actionType: 'delete_email' });
    await expect(
      router.executeWithRouting(action, makeRisk({ actionId: 'action-3' }), 'user-1'),
    ).rejects.toThrow(InvariantViolationError);
  });

  it('refuses an untrusted irreversible action on the auto-execute path', async () => {
    const action = makeAction({
      id: 'action-4',
      actionType: 'send_reply',
      reversible: false,
      provenance: 'untrusted_external',
    });
    await expect(
      router.executeWithRouting(action, makeRisk({ actionId: 'action-4' }), 'user-1'),
    ).rejects.toThrow(InvariantViolationError);
  });

  it('allows an extreme-severity action when the caller presents an approved context', async () => {
    const action = makeAction({
      id: 'action-5',
      actionType: 'shell_exec',
      reversible: false,
    });
    const result = await router.executeWithRouting(
      action,
      makeRisk({ actionId: 'action-5' }),
      'user-1',
      { approved: true },
    );
    expect(result.status).toBe('completed');
  });

  it('allows a destructive action through the approved path', async () => {
    const action = makeAction({ id: 'action-6', actionType: 'delete_email' });
    const result = await router.executeWithRouting(
      action,
      makeRisk({ actionId: 'action-6' }),
      'user-1',
      { approved: true },
    );
    expect(result.status).toBe('completed');
  });

  it('fails safe — an action with no provenance that is irreversible is refused on auto-execute', async () => {
    const action = makeAction({
      id: 'action-7',
      actionType: 'send_reply',
      reversible: false,
      provenance: undefined,
    });
    await expect(
      router.executeWithRouting(action, makeRisk({ actionId: 'action-7' }), 'user-1'),
    ).rejects.toThrow(InvariantViolationError);
  });

  it('refuses an extreme action on the streaming auto-execute path too', async () => {
    const action = makeAction({
      id: 'action-8',
      actionType: 'drop_table',
      reversible: false,
    });
    await expect(async () => {
      for await (const _ of router.executeWithRoutingStreaming(
        action,
        makeRisk({ actionId: 'action-8' }),
        'user-1',
      )) {
        // should throw before yielding anything
      }
    }).rejects.toThrow(InvariantViolationError);
  });
});
