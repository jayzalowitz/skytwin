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
import { ExecutionRouter, NoAdapterError, InvariantViolationError } from '../execution-router.js';
import {
  AdapterRegistry,
  IRONCLAW_TRUST_PROFILE,
  OPENCLAW_TRUST_PROFILE,
  DIRECT_TRUST_PROFILE,
} from '../adapter-registry.js';
import { OPENCLAW_SKILLS } from '../openclaw-adapter.js';

// ── Test helpers ─────────────────────────────────────────────────────

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    actionType: 'send_email',
    description: 'Send a follow-up email',
    domain: 'email',
    parameters: { to: 'test@example.com', subject: 'Hello' },
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'User typically sends follow-ups after meetings',
    ...overrides,
  };
}

function makeRiskAssessment(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    actionId: 'action-1',
    overallTier: RiskTier.LOW,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: { tier: RiskTier.LOW, score: 0.2, reasoning: 'Reversible' },
      [RiskDimension.FINANCIAL_IMPACT]: { tier: RiskTier.NEGLIGIBLE, score: 0, reasoning: 'Free' },
      [RiskDimension.LEGAL_SENSITIVITY]: { tier: RiskTier.NEGLIGIBLE, score: 0, reasoning: 'None' },
      [RiskDimension.PRIVACY_SENSITIVITY]: { tier: RiskTier.LOW, score: 0.1, reasoning: 'Low' },
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: { tier: RiskTier.LOW, score: 0.2, reasoning: 'Low' },
      [RiskDimension.OPERATIONAL_RISK]: { tier: RiskTier.NEGLIGIBLE, score: 0, reasoning: 'None' },
    },
    reasoning: 'Low risk email action',
    assessedAt: new Date(),
    ...overrides,
  };
}

function createMockAdapter(name: string, skills?: Set<string>): IronClawAdapter {
  const skillSet = skills;
  return {
    async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
      if (skillSet && !skillSet.has(action.actionType)) {
        throw new Error(`${name} cannot handle ${action.actionType}`);
      }
      return {
        id: `${name}_plan_1`,
        decisionId: action.decisionId,
        action,
        steps: [
          {
            id: `${name}_step_1`,
            order: 1,
            type: action.actionType,
            description: action.description,
            parameters: action.parameters,
            timeout: 30000,
          },
        ],
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
    async getStatus(_planId: string) {
      return 'completed';
    },
    async rollback(_planId: string): Promise<RollbackResult> {
      return { success: true, message: `Rolled back by ${name}` };
    },
    async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
      return { healthy: true, latencyMs: 10 };
    },
  };
}

/**
 * Adapter that throws from execute() — simulates failure before execution started.
 * Safe to fall back from because no action was performed.
 */
function createThrowingAdapter(name: string): IronClawAdapter {
  return {
    async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
      return {
        id: `${name}_plan_1`,
        decisionId: action.decisionId,
        action,
        steps: [],
        rollbackSteps: [],
        createdAt: new Date(),
      };
    },
    async execute(_plan: ExecutionPlan): Promise<ExecutionResult> {
      throw new Error(`${name} execution failed`);
    },
    async getStatus(_planId: string) {
      return 'failed';
    },
    async rollback(_planId: string): Promise<RollbackResult> {
      return { success: false, message: 'Rollback failed' };
    },
    async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
      return { healthy: false, latencyMs: 0 };
    },
  };
}

/**
 * Adapter that returns a non-completed status — simulates partial execution.
 * NOT safe to fall back from because the action may have been partially performed.
 */
function createSoftFailAdapter(name: string): IronClawAdapter {
  return {
    async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
      return {
        id: `${name}_plan_1`,
        decisionId: action.decisionId,
        action,
        steps: [],
        rollbackSteps: [],
        createdAt: new Date(),
      };
    },
    async execute(_plan: ExecutionPlan): Promise<ExecutionResult> {
      return {
        planId: `${name}_plan_1`,
        status: 'failed',
        startedAt: new Date(),
        completedAt: new Date(),
        error: `${name} execution failed`,
      };
    },
    async getStatus(_planId: string) {
      return 'failed';
    },
    async rollback(_planId: string): Promise<RollbackResult> {
      return { success: false, message: 'Rollback failed' };
    },
    async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
      return { healthy: false, latencyMs: 0 };
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ExecutionRouter', () => {
  let registry: AdapterRegistry;
  let router: ExecutionRouter;

  beforeEach(() => {
    registry = new AdapterRegistry();
    router = new ExecutionRouter(registry);
  });

  it('selects IronClaw for standard actions when available', async () => {
    const ironclawSkills = new Set(['send_email', 'archive_email', 'create_calendar_event']);
    registry.register('ironclaw', createMockAdapter('ironclaw', ironclawSkills), IRONCLAW_TRUST_PROFILE, ironclawSkills);
    registry.register('openclaw', createMockAdapter('openclaw', OPENCLAW_SKILLS), OPENCLAW_TRUST_PROFILE, OPENCLAW_SKILLS);
    registry.register('direct', createMockAdapter('direct'), DIRECT_TRUST_PROFILE);

    const action = makeAction({ actionType: 'send_email' });
    const risk = makeRiskAssessment();

    const decision = await router.route(action, risk, 'user-1');

    expect(decision.selectedAdapter).toBe('ironclaw');
    expect(decision.trustProfile.reversibilityGuarantee).toBe('full');
    expect(decision.riskModifierApplied).toBe(0);
    expect(decision.fallbackChain).toContain('openclaw');
  });

  it('falls back to OpenClaw when IronClaw cannot handle the action type', async () => {
    const ironclawSkills = new Set(['send_email', 'archive_email']);
    registry.register('ironclaw', createMockAdapter('ironclaw', ironclawSkills), IRONCLAW_TRUST_PROFILE, ironclawSkills);
    registry.register('openclaw', createMockAdapter('openclaw', OPENCLAW_SKILLS), OPENCLAW_TRUST_PROFILE, OPENCLAW_SKILLS);

    const action = makeAction({ actionType: 'social_media_post' });
    const risk = makeRiskAssessment();

    const decision = await router.route(action, risk, 'user-1');

    expect(decision.selectedAdapter).toBe('openclaw');
    expect(decision.trustProfile.name).toBe('openclaw');
  });

  it('falls back to Direct for simple actions when other adapters are unavailable', async () => {
    registry.register('direct', createMockAdapter('direct'), DIRECT_TRUST_PROFILE);

    const action = makeAction({ actionType: 'send_email' });
    const risk = makeRiskAssessment();

    const decision = await router.route(action, risk, 'user-1');

    expect(decision.selectedAdapter).toBe('direct');
    expect(decision.trustProfile.authModel).toBe('none');
    expect(decision.fallbackChain).toHaveLength(0);
  });

  it('applies risk modifier for OpenClaw irreversible actions', async () => {
    registry.register('openclaw', createMockAdapter('openclaw', OPENCLAW_SKILLS), OPENCLAW_TRUST_PROFILE, OPENCLAW_SKILLS);

    const action = makeAction({ actionType: 'send_email', reversible: false });
    const risk = makeRiskAssessment({ overallTier: RiskTier.LOW });

    const decision = await router.route(action, risk, 'user-1');

    expect(decision.selectedAdapter).toBe('openclaw');
    expect(decision.riskModifierApplied).toBe(1);
    expect(decision.reasoning).toContain('Risk modifier');
  });

  it('logs skill gap when no adapter can handle the action', async () => {
    const ironclawSkills = new Set(['send_email']);
    registry.register('ironclaw', createMockAdapter('ironclaw', ironclawSkills), IRONCLAW_TRUST_PROFILE, ironclawSkills);

    const action = makeAction({ actionType: 'quantum_teleport' });
    const risk = makeRiskAssessment();

    await expect(router.route(action, risk, 'user-1')).rejects.toThrow(NoAdapterError);

    try {
      await router.route(action, risk, 'user-1');
    } catch (err: unknown) {
      const error = err as NoAdapterError;
      expect(error.skillGap.actionType).toBe('quantum_teleport');
      expect(error.skillGap.userId).toBe('user-1');
      expect(error.skillGap.attemptedAdapters).toHaveLength(0);
    }
  });

  it('detects enhanced IronClaw adapters', () => {
    const basic = createMockAdapter('basic');
    registry.register('basic', basic, DIRECT_TRUST_PROFILE);
    expect(registry.isEnhanced('basic')).toBe(false);

    const enhanced = {
      ...createMockAdapter('enhanced'),
      async *executeStreaming(plan: ExecutionPlan) {
        yield {
          planId: plan.id,
          eventType: 'plan_completed' as const,
          timestamp: new Date(),
        };
      },
      async registerCredential() {
        return { success: true };
      },
      async revokeCredential() {
        return { success: true };
      },
      async listCredentials() {
        return [];
      },
      async sendChatCompletion() {
        return { content: 'ok', model: 'test', usage: { promptTokens: 0, completionTokens: 0 } };
      },
      async discoverTools() {
        return [];
      },
      async createRoutine() {
        return { routineId: 'routine_1' };
      },
      async listRoutines() {
        return [];
      },
      async deleteRoutine() {
        return { success: true };
      },
    };

    registry.register('enhanced', enhanced, IRONCLAW_TRUST_PROFILE);
    expect(registry.isEnhanced('enhanced')).toBe(true);
  });

  describe('executeWithRouting', () => {
    it('executes with the primary adapter on success', async () => {
      registry.register('ironclaw', createMockAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);
      registry.register('openclaw', createMockAdapter('openclaw', OPENCLAW_SKILLS), OPENCLAW_TRUST_PROFILE, OPENCLAW_SKILLS);

      const action = makeAction();
      const risk = makeRiskAssessment();

      const result = await router.executeWithRouting(action, risk, 'user-1');

      expect(result.status).toBe('completed');
      expect(result.output?.['adapter_used']).toBe('ironclaw');
      expect(result.output?.['fallbacks_attempted']).toBe(0);
    });

    it('falls back to next adapter when primary throws', async () => {
      registry.register('ironclaw', createThrowingAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);
      registry.register('direct', createMockAdapter('direct'), DIRECT_TRUST_PROFILE);

      const action = makeAction();
      const risk = makeRiskAssessment();

      const result = await router.executeWithRouting(action, risk, 'user-1');

      expect(result.status).toBe('completed');
      expect(result.output?.['adapter_used']).toBe('direct');
      expect(result.output?.['fallbacks_attempted']).toBe(1);
    });

    it('throws NoAdapterError when all adapters throw', async () => {
      registry.register('ironclaw', createThrowingAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);
      registry.register('direct', createThrowingAdapter('direct'), DIRECT_TRUST_PROFILE);

      const action = makeAction();
      const risk = makeRiskAssessment();

      await expect(router.executeWithRouting(action, risk, 'user-1')).rejects.toThrow(
        NoAdapterError,
      );
    });

    it('rollback flows through the selected adapter after execution', async () => {
      const mockIronclaw = createMockAdapter('ironclaw');
      registry.register('ironclaw', mockIronclaw, IRONCLAW_TRUST_PROFILE);

      const action = makeAction({ reversible: true });
      const risk = makeRiskAssessment();

      // Execute
      const execResult = await router.executeWithRouting(action, risk, 'user-1');
      expect(execResult.status).toBe('completed');

      // Rollback through the adapter
      const rollbackResult = await mockIronclaw.rollback(execResult.planId);
      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.message).toContain('ironclaw');
    });

    it('does not fall back when adapter returns non-completed status (partial execution risk)', async () => {
      registry.register('ironclaw', createSoftFailAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);
      registry.register('direct', createMockAdapter('direct'), DIRECT_TRUST_PROFILE);

      const action = makeAction();
      const risk = makeRiskAssessment();

      const result = await router.executeWithRouting(action, risk, 'user-1');

      // Should return the failed result, NOT fall back to direct adapter
      expect(result.status).toBe('failed');
      expect(result.output?.['adapter_used']).toBe('ironclaw');
      expect(result.output?.['fallback_skipped_reason']).toContain('fallback unsafe');
    });
  });

  describe('safety invariant guards', () => {
    let router: ExecutionRouter;

    beforeEach(() => {
      const registry = new AdapterRegistry();
      registry.register('ironclaw', createMockAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);
      router = new ExecutionRouter(registry);
    });

    it('throws InvariantViolationError when executeWithRouting is called without a RiskAssessment', async () => {
      const action = makeAction();
      await expect(
        router.executeWithRouting(action, null as unknown as RiskAssessment, 'user-1'),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('throws InvariantViolationError when executeWithRouting is called without a CandidateAction', async () => {
      const assessment = makeRiskAssessment();
      await expect(
        router.executeWithRouting(null as unknown as CandidateAction, assessment, 'user-1'),
      ).rejects.toThrow(/without a CandidateAction/);
    });

    it('throws InvariantViolationError when executeWithRouting is given a mismatched assessment', async () => {
      const action = makeAction({ id: 'action-A' });
      const assessment = makeRiskAssessment({ actionId: 'action-B' });
      await expect(
        router.executeWithRouting(action, assessment, 'user-1'),
      ).rejects.toThrow(/does not match/);
    });

    it('throws InvariantViolationError from executeWithRoutingStreaming on null assessment', async () => {
      const action = makeAction();
      const stream = router.executeWithRoutingStreaming(
        action,
        null as unknown as RiskAssessment,
        'user-1',
      );
      await expect((async () => {
        for await (const _ of stream) {
          // noop
        }
      })()).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('throws InvariantViolationError from executeWithRoutingStreaming on mismatched id', async () => {
      const action = makeAction({ id: 'action-A' });
      const assessment = makeRiskAssessment({ actionId: 'action-B' });
      const stream = router.executeWithRoutingStreaming(action, assessment, 'user-1');
      await expect((async () => {
        for await (const _ of stream) {
          // noop
        }
      })()).rejects.toThrow(/does not match/);
    });
  });
});
