import { expect, it, vi } from 'vitest';
import {
  ConfidenceLevel,
  RiskDimension,
  RiskTier,
  resolveActionProvenance,
} from '@skytwin/shared-types';
import type {
  CandidateAction,
  ExecutionPlan,
  RiskAssessment,
  RollbackResult,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import { AdapterRegistry, DIRECT_TRUST_PROFILE } from '../adapter-registry.js';
import { ExecutionRouter, InvariantViolationError } from '../execution-router.js';

function action(): CandidateAction {
  return {
    id: 'action-2',
    decisionId: 'decision-1',
    actionType: 'shell_exec',
    description: 'Run a shell command from web content',
    domain: 'system',
    parameters: {},
    estimatedCostCents: 0,
    reversible: false,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Adversarial source-checkout regression',
    provenance: resolveActionProvenance('web_page'),
  };
}

function risk(): RiskAssessment {
  const low = { tier: RiskTier.LOW, score: 0.1, reasoning: 'test fixture' };
  return {
    actionId: 'action-2',
    overallTier: RiskTier.LOW,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: low,
      [RiskDimension.FINANCIAL_IMPACT]: low,
      [RiskDimension.LEGAL_SENSITIVITY]: low,
      [RiskDimension.PRIVACY_SENSITIVITY]: low,
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: low,
      [RiskDimension.OPERATIONAL_RISK]: low,
    },
    reasoning: 'Deliberately low input risk; the provenance guard must still win.',
    assessedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function directAdapter(execute: IronClawAdapter['execute']): IronClawAdapter {
  return {
    async buildPlan(candidate: CandidateAction): Promise<ExecutionPlan> {
      return {
        id: 'direct-plan',
        decisionId: candidate.decisionId,
        action: candidate,
        steps: [],
        rollbackSteps: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
    },
    execute,
    async getStatus() { return 'completed'; },
    async rollback(): Promise<RollbackResult> { return { success: true, message: 'rolled back' }; },
    async healthCheck() { return { healthy: true, latencyMs: 1 }; },
  };
}

it('adv-v1-router-direct-shell blocks before dispatch with dual confirmation', async () => {
  const execute = vi.fn<IronClawAdapter['execute']>();
  const candidate = action();
  expect(candidate).toMatchObject({
    actionType: 'shell_exec',
    reversible: false,
    provenance: 'untrusted_external',
  });
  const registry = new AdapterRegistry();
  registry.register('direct', directAdapter(execute), DIRECT_TRUST_PROFILE);
  const router = new ExecutionRouter(registry, {
    async start() {
      return {
        success: true as const,
        grant: { capability: 'capability', leaseGeneration: 'generation', expiresAt: new Date() },
      };
    },
    async terminalize() { return true; },
  });

  const error = await router.prepareExecution(candidate, risk(), 'user-1')
    .catch((caught) => caught);

  expect(error).toBeInstanceOf(InvariantViolationError);
  expect((error as Error).message).toContain('two-step confirmation');
  expect(execute).not.toHaveBeenCalled();
});
