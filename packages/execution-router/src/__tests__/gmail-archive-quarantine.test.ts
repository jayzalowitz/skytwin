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
import { AdapterRegistry, DIRECT_TRUST_PROFILE } from '../adapter-registry.js';
import { ExecutionRouter, InvariantViolationError } from '../execution-router.js';

function action(actionType = 'label_email', parameters: Record<string, unknown> = {}): CandidateAction {
  return {
    id: 'action-1', decisionId: 'decision-1', actionType,
    description: 'Test action', domain: 'email', parameters: {
      ...parameters,
      credentialAuthorityRevision: 'authority-1',
      credentialPolicyAuthorityRevision: 'policy-1',
      dispatchAuthorityId: 'admission-1',
      dispatchAuthorityUpdatedAt: '2026-09-16T00:00:00.000Z',
    },
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
    reasoning: 'low', assessedAt: new Date('2026-09-16T00:00:00.000Z'),
  };
}

describe('ExecutionRouter Gmail archive quarantine', () => {
  let router: ExecutionRouter;
  let buildPlan: Mock<IronClawAdapter['buildPlan']>;
  let execute: Mock<IronClawAdapter['execute']>;
  let rollback: Mock<IronClawAdapter['rollback']>;

  beforeEach(() => {
    buildPlan = vi.fn(async (candidate: CandidateAction): Promise<ExecutionPlan> => ({
      id: candidate.parameters['executionPlanId'] as string,
      decisionId: candidate.decisionId,
      action: candidate,
      steps: [{
        id: 'adapter-step', order: 1, type: candidate.actionType,
        description: candidate.description, parameters: candidate.parameters, timeout: 30_000,
      }],
      rollbackSteps: [],
      createdAt: new Date('2026-09-16T00:00:00.000Z'),
    }));
    execute = vi.fn(async (plan: ExecutionPlan): Promise<ExecutionResult> => ({
      planId: plan.id, status: 'completed', startedAt: new Date(),
      completedAt: new Date(), output: {},
    }));
    rollback = vi.fn(async (): Promise<RollbackResult> => ({ success: true, message: 'ok' }));
    const adapter = {
      buildPlan, execute, rollback,
      async getStatus() { return 'completed' as const; },
      async healthCheck() { return { healthy: true, latencyMs: 1 }; },
    } as IronClawAdapter;
    const registry = new AdapterRegistry();
    registry.register('direct', adapter, DIRECT_TRUST_PROFILE, new Set(['archive_email', 'label_email']));
    router = new ExecutionRouter(registry, {
      start: vi.fn(async () => ({
        success: true as const,
        grant: { capability: 'opaque', leaseGeneration: 'generation', expiresAt: new Date() },
      })),
      terminalize: vi.fn(async () => true),
    });
  });

  it.each([
    {},
    { emailId: 'legacy-provider-id' },
    { schema: 'gmail_inbox_mutation_v1', messageRefId: 'opaque', operation: 'archive' },
    { schema: 'mixed', operation: 'restore', unrelated: true },
  ])('rejects every archive parameter shape before adapter work: %o', async (parameters) => {
    await expect(router.route(action('archive_email', parameters), risk(), 'user-1'))
      .rejects.toThrow('reserved for its dedicated execution lifecycle');
    expect(buildPlan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects approved and streaming archive dispatch before adapter work', async () => {
    await expect(router.executeWithRouting(
      action('archive_email'), risk(), 'user-1', { approved: true },
    )).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(async () => {
      for await (const _event of router.executeWithRoutingStreaming(
        action('archive_email'), risk(), 'user-1', { approved: true },
      )) { /* no events */ }
    }).rejects.toBeInstanceOf(InvariantViolationError);
    expect(buildPlan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed on an accessor without invoking it', async () => {
    const getter = vi.fn(() => 'archive_email');
    const hostile = Object.defineProperty({}, 'actionType', {
      enumerable: true,
      get: getter,
    }) as unknown as CandidateAction;
    await expect(router.route(hostile, risk(), 'user-1'))
      .rejects.toThrow('could not be inspected safely');
    expect(getter).not.toHaveBeenCalled();
    expect(buildPlan).not.toHaveBeenCalled();
  });

  it('blocks generic rollback for archive identity and malformed identity', async () => {
    await expect(router.rollback('plan-1', 'direct', {
      actionId: 'action-1', actionType: 'archive_email',
    })).resolves.toMatchObject({ result: { success: false, message: 'rollback_action_reserved' } });
    await expect(router.rollback('plan-1', 'direct')).resolves.toMatchObject({
      result: { success: false, message: 'rollback_action_identity_invalid' },
    });
    expect(rollback).not.toHaveBeenCalled();
  });

  it('does not affect an unrelated email action or rollback', async () => {
    await expect(router.executeWithRouting(action(), risk(), 'user-1'))
      .resolves.toMatchObject({ status: 'completed' });
    await expect(router.rollback('plan-1', 'direct', {
      actionId: 'action-1', actionType: 'label_email',
    })).resolves.toMatchObject({ result: { success: true } });
    expect(buildPlan).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
  });
});
