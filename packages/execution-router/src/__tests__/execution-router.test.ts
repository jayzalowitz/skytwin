import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RiskTier, ConfidenceLevel, RiskDimension } from '@skytwin/shared-types';
import type {
  CandidateAction,
  RiskAssessment,
  ExecutionPlan,
  ExecutionResult,
  RollbackResult,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import {
  AmbiguousExecutionError,
  ExecutionRouter,
  NoAdapterError,
  InvariantViolationError,
} from '../execution-router.js';
import type { PreparedExecution } from '../execution-router.js';
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
    // label_email + user_originated: reversible, non-destructive, trusted
    // provenance — so the execution-router injection-guard backstop does not
    // fire, keeping these tests focused on routing/fallback mechanics. The
    // backstop itself is covered by injection-guard-backstop.test.ts. The
    // `route()`-only tests below override actionType where they need to.
    actionType: 'label_email',
    description: 'Label an email',
    domain: 'email',
    parameters: { messageId: 'msg-1' },
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'User typically labels newsletters',
    provenance: 'user_originated',
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
 * Adapter that throws from execute(). Dispatch already began, so its result is
 * ambiguous and must never trigger fallback.
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

function createBuildThrowingAdapter(name: string): IronClawAdapter {
  return {
    async buildPlan(): Promise<ExecutionPlan> { throw new Error(`${name} build failed`); },
    async execute(): Promise<ExecutionResult> { throw new Error('must not dispatch'); },
    async getStatus() { return 'failed'; },
    async rollback(): Promise<RollbackResult> { return { success: false, message: 'not run' }; },
    async healthCheck() { return { healthy: false, latencyMs: 0 }; },
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

  it('allowlists streaming event metadata and drops adapter-controlled payload fields', async () => {
    const adapter = {
      ...createMockAdapter('ironclaw'),
      async *executeStreaming(_plan: ExecutionPlan) {
        yield {
          planId: 'SECRET_MARKER_PLAN',
          stepId: 'SECRET_MARKER_STEP',
          eventType: 'plan_completed' as const,
          timestamp: new Date(),
          payload: { peerText: 'SECRET_MARKER_PAYLOAD' },
          extra: 'SECRET_MARKER_EXTRA',
        };
      },
    };
    registry.register('ironclaw', adapter, IRONCLAW_TRUST_PROFILE);
    const events = [];

    for await (const event of router.executeWithRoutingStreaming(
      makeAction(), makeRiskAssessment(), 'user-1',
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('SECRET_MARKER');
    expect(events[0]?.payload).toEqual(expect.objectContaining({ adapter_used: 'ironclaw' }));
  });

  it('binds streaming plans to the canonical owner and rejects conflicts before dispatch', async () => {
    const adapter = {
      ...createMockAdapter('ironclaw'),
      async *executeStreaming(_plan: ExecutionPlan) {
        yield {
          planId: 'plan-1',
          eventType: 'plan_completed' as const,
          timestamp: new Date(),
          payload: {},
        };
      },
    };
    const build = vi.spyOn(adapter, 'buildPlan');
    const executeStreaming = vi.spyOn(adapter, 'executeStreaming');
    registry.register('ironclaw', adapter, IRONCLAW_TRUST_PROFILE);

    for await (const _event of router.executeWithRoutingStreaming(
      makeAction(), makeRiskAssessment(), 'tenant-a',
    )) { /* drain */ }
    expect(build).toHaveBeenCalledWith(expect.objectContaining({
      parameters: expect.objectContaining({ userId: 'tenant-a' }),
    }));

    const conflicting = makeAction({ parameters: { messageId: 'msg-1', userId: 'tenant-b' } });
    const conflictRisk = makeRiskAssessment({ actionId: conflicting.id });
    const stream = router.executeWithRoutingStreaming(conflicting, conflictRisk, 'tenant-a');
    await expect(stream[Symbol.asyncIterator]().next())
      .rejects.toThrow('does not match the execution owner');
    expect(executeStreaming).toHaveBeenCalledTimes(1);
  });

  describe('executeWithRouting', () => {
    it.each(['ironclaw', 'direct'])('binds %s plans to the canonical owner', async (name) => {
      const adapter = createMockAdapter(name);
      const build = vi.spyOn(adapter, 'buildPlan');
      registry.register(
        name,
        adapter,
        name === 'direct' ? DIRECT_TRUST_PROFILE : IRONCLAW_TRUST_PROFILE,
      );

      await router.executeWithRouting(makeAction(), makeRiskAssessment(), 'tenant-a');

      expect(build).toHaveBeenCalledWith(expect.objectContaining({
        parameters: expect.objectContaining({ userId: 'tenant-a' }),
      }));
    });

    it('rejects a conflicting owner before legacy dispatch', async () => {
      const adapter = createMockAdapter('ironclaw');
      const build = vi.spyOn(adapter, 'buildPlan');
      const execute = vi.spyOn(adapter, 'execute');
      registry.register('ironclaw', adapter, IRONCLAW_TRUST_PROFILE);
      const action = makeAction({ parameters: { messageId: 'msg-1', userId: 'tenant-b' } });
      const risk = makeRiskAssessment({ actionId: action.id });

      await expect(router.executeWithRouting(action, risk, 'tenant-a'))
        .rejects.toThrow('does not match the execution owner');
      expect(build).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

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

    it.each(['ironclaw', 'direct'])('binds the canonical owner before %s builds a plan', async (name) => {
      const adapter = createMockAdapter(name);
      const build = vi.spyOn(adapter, 'buildPlan');
      registry.register(
        name,
        adapter,
        name === 'ironclaw' ? IRONCLAW_TRUST_PROFILE : DIRECT_TRUST_PROFILE,
      );

      await router.executeWithRouting(makeAction(), makeRiskAssessment(), 'tenant-a');

      expect(build).toHaveBeenCalledWith(expect.objectContaining({
        parameters: expect.objectContaining({ userId: 'tenant-a' }),
      }));
    });

    it('rejects a conflicting embedded owner before any legacy dispatch', async () => {
      const adapter = createMockAdapter('ironclaw');
      const build = vi.spyOn(adapter, 'buildPlan');
      const execute = vi.spyOn(adapter, 'execute');
      registry.register('ironclaw', adapter, IRONCLAW_TRUST_PROFILE);

      await expect(router.executeWithRouting(
        makeAction({ parameters: { messageId: 'msg-1', userId: 'tenant-b' } }),
        makeRiskAssessment(),
        'tenant-a',
      )).rejects.toThrow('does not match the execution owner');
      expect(build).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('falls back only when primary plan construction fails before dispatch', async () => {
      registry.register('ironclaw', createBuildThrowingAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);
      registry.register('direct', createMockAdapter('direct'), DIRECT_TRUST_PROFILE);

      const action = makeAction();
      const risk = makeRiskAssessment();

      const result = await router.executeWithRouting(action, risk, 'user-1');

      expect(result.status).toBe('completed');
      expect(result.output?.['adapter_used']).toBe('direct');
      expect(result.output?.['fallbacks_attempted']).toBe(1);
    });

    it('does not fall back when execute throws after dispatch began', async () => {
      registry.register('ironclaw', createThrowingAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);
      const direct = createMockAdapter('direct');
      const directExecute = vi.spyOn(direct, 'execute');
      registry.register('direct', direct, DIRECT_TRUST_PROFILE);

      const action = makeAction();
      const risk = makeRiskAssessment();

      await expect(router.executeWithRouting(action, risk, 'user-1')).rejects.toThrow(
        AmbiguousExecutionError,
      );
      expect(directExecute).not.toHaveBeenCalled();
    });

    it('throws NoAdapterError when every adapter fails before dispatch', async () => {
      registry.register('ironclaw', createBuildThrowingAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);
      registry.register('direct', createBuildThrowingAdapter('direct'), DIRECT_TRUST_PROFILE);
      await expect(router.executeWithRouting(makeAction(), makeRiskAssessment(), 'user-1'))
        .rejects.toThrow(NoAdapterError);
    });

    it('executes an immutable prepared route without re-routing or fallback', async () => {
      const primary = createMockAdapter('ironclaw');
      const fallback = createMockAdapter('direct');
      const fallbackExecute = vi.spyOn(fallback, 'execute');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      registry.register('direct', fallback, DIRECT_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');
      const prepared = await router.prepareExecution(action, route, 'user-1');

      const result = await router.executePrepared(prepared, 'user-1');

      expect(result.output?.['adapter_used']).toBe('ironclaw');
      expect(result.output?.['fallbacks_attempted']).toBe(0);
      expect(fallbackExecute).not.toHaveBeenCalled();
    });

    it('rejects a fabricated prepared handle without dispatching', async () => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');
      const fabricated = {
        selectedAdapter: 'ironclaw',
        routingDecision: route,
        plan: await primary.buildPlan(action),
      } as PreparedExecution;

      await expect(router.executePrepared(fabricated, 'user-1')).rejects.toThrow(InvariantViolationError);
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a copied structural routing decision before plan construction', async () => {
      const primary = createMockAdapter('ironclaw');
      const buildPlan = vi.spyOn(primary, 'buildPlan');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');

      await expect(router.prepareExecution(action, { ...route }, 'user-1'))
        .rejects.toThrow('not issued by this router');
      expect(buildPlan).not.toHaveBeenCalled();
    });

    it('rejects registry replacement between route and preparation', async () => {
      const original = createMockAdapter('ironclaw');
      const replacement = createMockAdapter('replacement');
      const originalBuild = vi.spyOn(original, 'buildPlan');
      const replacementBuild = vi.spyOn(replacement, 'buildPlan');
      registry.register('ironclaw', original, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');

      registry.register('ironclaw', replacement, IRONCLAW_TRUST_PROFILE);
      await expect(router.prepareExecution(action, route, 'user-1'))
        .rejects.toThrow('changed before preparation');
      expect(originalBuild).not.toHaveBeenCalled();
      expect(replacementBuild).not.toHaveBeenCalled();
    });

    it('rejects a plan whose action differs from the risk-assessed candidate', async () => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      vi.spyOn(primary, 'buildPlan').mockImplementation(async (action) => ({
        id: 'forged-plan',
        decisionId: action.decisionId,
        action: { ...action, parameters: { messageId: 'different-message' } },
        steps: [],
        rollbackSteps: [],
        createdAt: new Date(),
      }));
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');

      await expect(router.prepareExecution(action, route, 'user-1'))
        .rejects.toThrow('does not match the risk-assessed candidate');
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects mutation of a prepared handle without dispatching', async () => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');
      const prepared = await router.prepareExecution(action, route, 'user-1');

      // Object.freeze does not disable Date mutator methods. The private
      // fingerprint check must still catch this deep mutation.
      expect(() => prepared.plan.createdAt.setTime(prepared.plan.createdAt.getTime() + 1))
        .toThrow('immutable');
      await expect(router.executePrepared(prepared, 'user-1')).rejects.toThrow('mutated before dispatch');
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects registry replacement between preparation and dispatch', async () => {
      const original = createMockAdapter('ironclaw');
      const replacement = createMockAdapter('replacement');
      const originalExecute = vi.spyOn(original, 'execute');
      const replacementExecute = vi.spyOn(replacement, 'execute');
      registry.register('ironclaw', original, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');
      const prepared = await router.prepareExecution(action, route, 'user-1');

      registry.register('ironclaw', replacement, IRONCLAW_TRUST_PROFILE);
      await expect(router.executePrepared(prepared, 'user-1')).rejects.toThrow('removed or replaced');
      expect(originalExecute).not.toHaveBeenCalled();
      expect(replacementExecute).not.toHaveBeenCalled();
    });

    it('rejects trust-profile replacement on the same adapter before dispatch', async () => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');
      const prepared = await router.prepareExecution(action, route, 'user-1');

      registry.register('ironclaw', primary, { ...IRONCLAW_TRUST_PROFILE, riskModifier: 1 });

      await expect(router.executePrepared(prepared, 'user-1')).rejects.toThrow('removed or replaced');
      expect(execute).not.toHaveBeenCalled();
    });

    it('clones trust profiles so caller mutation cannot change a prepared route', async () => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      const profile = { ...IRONCLAW_TRUST_PROFILE };
      registry.register('ironclaw', primary, profile);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');
      const prepared = await router.prepareExecution(action, route, 'user-1');

      profile.riskModifier = 1;

      await expect(router.executePrepared(prepared, 'user-1')).resolves.toMatchObject({ status: 'completed' });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('clones skill declarations and revision-invalidates same-adapter re-registration', async () => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      const skills = new Set([makeAction().actionType]);
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE, skills);
      skills.clear();
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');
      const prepared = await router.prepareExecution(action, route, 'user-1');

      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE, new Set([action.actionType]));

      await expect(router.executePrepared(prepared, 'user-1')).rejects.toThrow('removed or replaced');
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a caller-supplied tenant that conflicts with the route owner', async () => {
      const primary = createMockAdapter('ironclaw');
      const build = vi.spyOn(primary, 'buildPlan');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction({ parameters: { messageId: 'msg-1', userId: 'tenant-b' } });

      await expect(router.route(action, makeRiskAssessment(), 'tenant-a'))
        .rejects.toThrow('does not match the execution owner');
      expect(build).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant preparation and dispatch without executing', async () => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const firstRoute = await router.route(action, makeRiskAssessment(), 'tenant-a');

      await expect(router.prepareExecution(action, firstRoute, 'tenant-b'))
        .rejects.toThrow('changed before preparation');

      const secondRoute = await router.route(action, makeRiskAssessment(), 'tenant-a');
      const prepared = await router.prepareExecution(action, secondRoute, 'tenant-a');
      await expect(router.executePrepared(prepared, 'tenant-b'))
        .rejects.toThrow('removed or replaced');
      expect(execute).not.toHaveBeenCalled();
    });

    it('copies caller-owned action and risk data and consumes a handle once', async () => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const risk = makeRiskAssessment();
      const route = await router.route(action, risk, 'user-1');
      const prepared = await router.prepareExecution(action, route, 'user-1');

      expect(prepared.plan.action).not.toBe(action);
      expect(prepared.routingDecision.modifiedRiskAssessment).not.toBe(risk);
      expect(Object.isFrozen(prepared.plan)).toBe(true);
      expect(Object.isFrozen(prepared.plan.action)).toBe(true);
      expect(Object.isFrozen(prepared.plan.action.parameters)).toBe(true);
      expect(Object.isFrozen(prepared.routingDecision.modifiedRiskAssessment)).toBe(true);
      action.parameters['messageId'] = 'attacker-mutated';
      risk.reasoning = 'attacker-mutated';
      await router.executePrepared(prepared, 'user-1');
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({
        action: expect.objectContaining({ parameters: { messageId: 'msg-1', userId: 'user-1' } }),
      }));
      expect(prepared.routingDecision.modifiedRiskAssessment.reasoning).toBe('Low risk email action');
      await expect(router.executePrepared(prepared, 'user-1')).rejects.toThrow('already consumed');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('preserves canonical own __proto__ data without changing object prototypes', async () => {
      const primary = createMockAdapter('ironclaw');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const parameters: Record<string, unknown> = {};
      Object.defineProperty(parameters, '__proto__', {
        value: 'plain-data',
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const action = makeAction({ parameters });
      const route = await router.route(action, makeRiskAssessment(), 'user-1');

      const prepared = await router.prepareExecution(action, route, 'user-1');

      expect(Object.getPrototypeOf(prepared.plan.action.parameters)).toBe(Object.prototype);
      expect(Object.hasOwn(prepared.plan.action.parameters, '__proto__')).toBe(true);
      expect(prepared.plan.action.parameters['__proto__']).toBe('plain-data');
    });

    it.each([
      ['Map', new Map([['messageId', 'msg-1']])],
      ['Set', new Set(['msg-1'])],
      ['undefined value', undefined],
    ])('rejects a %s in prepared adapter data before dispatch', async (_kind, unsupported) => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      vi.spyOn(primary, 'buildPlan').mockResolvedValue({
        id: 'plan-unsupported',
        decisionId: makeAction().decisionId,
        action: makeAction({ parameters: { unsupported } }),
        steps: [],
        rollbackSteps: [],
        createdAt: new Date(),
      });
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');

      await expect(router.prepareExecution(action, route, 'user-1'))
        .rejects.toThrow(InvariantViolationError);
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects arrays with custom own properties before issuing a route', async () => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const recipients = ['a@example.com'];
      Object.defineProperty(recipients, 'metadata', {
        value: new Map([['secret', 'SECRET_MARKER']]),
        enumerable: false,
      });
      const action = makeAction({ parameters: { recipients } });

      await expect(router.route(action, makeRiskAssessment(), 'user-1'))
        .rejects.toThrow('non-canonical array property');
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a Map in caller data even when it is mutated after routing begins', async () => {
      const primary = createMockAdapter('ironclaw');
      const execute = vi.spyOn(primary, 'execute');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const map = new Map([['messageId', 'msg-1']]);
      const action = makeAction({ parameters: { map } });
      map.set('messageId', 'SECRET_MARKER');

      await expect(router.route(action, makeRiskAssessment(), 'user-1'))
        .rejects.toThrow('non-plain object');
      expect(execute).not.toHaveBeenCalled();
    });

    it.each([
      ['sparse array', () => new Array(1)],
      ['array subclass', () => new (class extends Array<string> {})('value')],
      ['symbol property', () => {
        const value: Record<PropertyKey, unknown> = { visible: true };
        value[Symbol('hidden')] = 'SECRET_MARKER';
        return value;
      }],
      ['accessor property', () => {
        const value: Record<string, unknown> = {};
        Object.defineProperty(value, 'secret', {
          enumerable: true,
          get: () => 'SECRET_MARKER',
        });
        return value;
      }],
      ['cyclic object', () => {
        const value: Record<string, unknown> = {};
        value['self'] = value;
        return value;
      }],
    ])('rejects %s values before plan construction', async (_kind, makeInvalid) => {
      const primary = createMockAdapter('ironclaw');
      const buildPlan = vi.spyOn(primary, 'buildPlan');
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);

      await expect(router.route(
        makeAction({ parameters: { invalid: makeInvalid() } }),
        makeRiskAssessment(),
        'user-1',
      )).rejects.toThrow(InvariantViolationError);
      expect(buildPlan).not.toHaveBeenCalled();
    });

    it('does not expose an adapter throwable after dispatch begins', async () => {
      const primary = createMockAdapter('ironclaw');
      vi.spyOn(primary, 'execute').mockRejectedValue(new Error('SECRET_MARKER provider echo'));
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');
      const prepared = await router.prepareExecution(action, route, 'user-1');

      const error = await router.executePrepared(prepared, 'user-1').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AmbiguousExecutionError);
      expect((error as Error).message).toBe('adapter_dispatch_ambiguous');
      expect(JSON.stringify(error)).not.toContain('SECRET_MARKER');
    });

    it('replaces an adapter-returned failure message with a bounded code', async () => {
      const primary = createMockAdapter('ironclaw');
      vi.spyOn(primary, 'execute').mockResolvedValue({
        planId: 'ironclaw_plan_1',
        status: 'failed',
        startedAt: new Date(),
        completedAt: new Date(),
        error: 'SECRET_MARKER provider echo',
        output: { provider_error_detail: 'SECRET_MARKER echoed in output' },
      });
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');
      const prepared = await router.prepareExecution(action, route, 'user-1');

      const result = await router.executePrepared(prepared, 'user-1');
      expect(result.error).toBe('adapter_execution_failed');
      expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
    });

    it('preserves a known adapter result when output decoration throws', async () => {
      const primary = createMockAdapter('ironclaw');
      const hostileOutput = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(hostileOutput, 'secret', {
        enumerable: true,
        get: () => { throw new Error('SECRET_MARKER decoration failure'); },
      });
      vi.spyOn(primary, 'execute').mockResolvedValue({
        planId: 'ironclaw_plan_1',
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        output: hostileOutput,
      });
      registry.register('ironclaw', primary, IRONCLAW_TRUST_PROFILE);
      const action = makeAction();
      const route = await router.route(action, makeRiskAssessment(), 'user-1');
      const prepared = await router.prepareExecution(action, route, 'user-1');

      await expect(router.executePrepared(prepared, 'user-1')).resolves.toMatchObject({
        status: 'completed',
        output: { adapter_used: 'ironclaw' },
      });
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

  // ── #324: rollback routing ──────────────────────────────────────────
  describe('rollback', () => {
    it('dispatches to the adapter that executed the plan (happy path)', async () => {
      const ironclaw = createMockAdapter('ironclaw');
      const openclaw = createMockAdapter('openclaw', OPENCLAW_SKILLS);
      const ironclawSpy = vi.spyOn(ironclaw, 'rollback');
      const openclawSpy = vi.spyOn(openclaw, 'rollback');
      registry.register('ironclaw', ironclaw, IRONCLAW_TRUST_PROFILE);
      registry.register('openclaw', openclaw, OPENCLAW_TRUST_PROFILE, OPENCLAW_SKILLS);

      const out = await router.rollback('plan-1', 'ironclaw');

      expect(out.result.success).toBe(true);
      expect(out.adapterUsed).toBe('ironclaw');
      expect(out.noAdapter).toBe(false);
      // Routed to the recorded adapter only — never the other registered one.
      expect(ironclawSpy).toHaveBeenCalledWith('plan-1');
      expect(openclawSpy).not.toHaveBeenCalled();
    });

    it('returns noAdapter when the recorded adapter is no longer registered', async () => {
      // ironclaw executed the plan but was since uninstalled — must NOT fall
      // back to a different adapter and ask it to roll back a plan it never ran.
      const direct = createMockAdapter('direct');
      const directSpy = vi.spyOn(direct, 'rollback');
      registry.register('direct', direct, DIRECT_TRUST_PROFILE);

      const out = await router.rollback('plan-1', 'ironclaw');

      expect(out.noAdapter).toBe(true);
      expect(out.result.success).toBe(false);
      expect(out.adapterUsed).toBe('ironclaw');
      expect(directSpy).not.toHaveBeenCalled();
    });

    it('returns noAdapter (fail-safe) when no adapter name was recorded', async () => {
      registry.register('ironclaw', createMockAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);

      const out = await router.rollback('plan-1', null);

      expect(out.noAdapter).toBe(true);
      expect(out.result.success).toBe(false);
      expect(out.adapterUsed).toBeNull();
    });

    it('surfaces an adapter-thrown error as a failed (not noAdapter) result', async () => {
      const ironclaw = createMockAdapter('ironclaw');
      vi.spyOn(ironclaw, 'rollback').mockRejectedValue(new Error('SECRET_MARKER boom'));
      registry.register('ironclaw', ironclaw, IRONCLAW_TRUST_PROFILE);

      const out = await router.rollback('plan-1', 'ironclaw');

      expect(out.noAdapter).toBe(false);
      expect(out.result.success).toBe(false);
      expect(out.result.message).toBe('adapter_rollback_failed');
      expect(JSON.stringify(out)).not.toContain('SECRET_MARKER');
      expect(out.adapterUsed).toBe('ironclaw');
    });

    it('bounds the adapter\'s own rollback failure', async () => {
      const ironclaw = createMockAdapter('ironclaw');
      vi.spyOn(ironclaw, 'rollback').mockResolvedValue({
        success: false,
        message: 'SECRET_MARKER This action is not reversible.',
      });
      registry.register('ironclaw', ironclaw, IRONCLAW_TRUST_PROFILE);

      const out = await router.rollback('plan-1', 'ironclaw');

      expect(out.noAdapter).toBe(false);
      expect(out.result.success).toBe(false);
      expect(out.result.message).toBe('adapter_rollback_failed');
      expect(JSON.stringify(out)).not.toContain('SECRET_MARKER');
    });
  });
});
