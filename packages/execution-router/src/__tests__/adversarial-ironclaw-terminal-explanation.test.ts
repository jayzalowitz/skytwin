import { expect, it, vi } from 'vitest';
import {
  ConfidenceLevel,
  RiskDimension,
  RiskTier,
  type CandidateAction,
  type ExecutionPlan,
  type RiskAssessment,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import { AdapterRegistry, IRONCLAW_TRUST_PROFILE } from '../adapter-registry.js';
import { ExecutionRouter } from '../execution-router.js';

const mappedScenario = {
  runtimeEntryPath: 'ironclaw_adapter.execute',
  adapter: 'ironclaw',
  criticalShape: 'send',
  action: { actionType: 'archive_email', reversible: true, parameters: {} },
  origin: { kind: 'user', source: 'user_request' },
  provenance: 'user_originated',
} as const;

const action: CandidateAction = {
  id: 'action-1', decisionId: 'decision-1', actionType: mappedScenario.action.actionType,
  description: 'Archive one message', domain: 'email', estimatedCostCents: 0,
  reversible: mappedScenario.action.reversible, confidence: ConfidenceLevel.HIGH,
  reasoning: 'Adversarial terminal ambiguity regression', provenance: mappedScenario.provenance,
  parameters: {
    messageId: 'message-1', credentialAuthorityRevision: 'authority-1',
    credentialPolicyAuthorityRevision: 'policy-1', dispatchAuthorityId: 'admission-1',
    dispatchAuthorityUpdatedAt: '2026-09-15T00:00:00.000Z',
  },
};
const risk: RiskAssessment = {
  actionId: action.id, overallTier: RiskTier.LOW,
  dimensions: Object.fromEntries(Object.values(RiskDimension).map((dimension) => [
    dimension, { tier: RiskTier.LOW, score: 0.1, reasoning: 'Bounded test risk' },
  ])) as RiskAssessment['dimensions'],
  reasoning: 'Bounded test risk', assessedAt: new Date('2026-09-15T00:00:00.000Z'),
};

it('records finite IronClaw ambiguity without retry or fallback', async () => {
  const execute = vi.fn(async () => { throw new Error('SECRET_MARKER response lost'); });
  const adapter = {
    canHandle: () => true,
    getMissingSkills: () => [],
    buildPlan: async (candidate: CandidateAction): Promise<ExecutionPlan> => ({
      id: candidate.parameters['executionPlanId'] as string,
      decisionId: candidate.decisionId,
      action: candidate,
      steps: [{
        id: 'step-1', order: 1, type: candidate.actionType,
        description: candidate.description, parameters: candidate.parameters, timeout: 30_000,
      }],
      rollbackSteps: [],
      createdAt: new Date(),
    }),
    prepareRequestStart: async () => ({ proof: {}, executionChannel: 'local' }),
    execute,
  } as unknown as IronClawAdapter;
  const terminalize = vi.fn(async () => true);
  const registry = new AdapterRegistry();
  registry.register('ironclaw', adapter, IRONCLAW_TRUST_PROFILE);
  const router = new ExecutionRouter(registry, {
    start: vi.fn(async () => ({
      success: true as const,
      grant: { capability: 'opaque', leaseGeneration: 'generation', expiresAt: new Date() },
    })),
    terminalize,
  });

  await expect(router.executeWithRouting(action, risk, 'user-1', { ironclawChannel: 'local' }))
    .rejects.toThrow('ambiguous');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(terminalize).toHaveBeenCalledWith(expect.objectContaining({
    state: 'ambiguous',
    ambiguity: { phase: 'adapter_execute', reasonCode: 'adapter_exception' },
  }));
  expect(JSON.stringify(terminalize.mock.calls)).not.toContain('SECRET_MARKER');
  expect({
    runtimeEntryPath: mappedScenario.runtimeEntryPath,
    adapter: mappedScenario.adapter,
    criticalShape: mappedScenario.criticalShape,
    action: mappedScenario.action,
    origin: mappedScenario.origin,
    provenance: action.provenance,
  }).toEqual(mappedScenario);
});
