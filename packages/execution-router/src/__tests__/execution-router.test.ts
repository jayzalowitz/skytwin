import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RiskTier, ConfidenceLevel, RiskDimension } from '@skytwin/shared-types';
import type {
  CandidateAction,
  RiskAssessment,
  ExecutionPlan,
  ExecutionResult,
  ExecutionEvent,
  RollbackResult,
} from '@skytwin/shared-types';
import type {
  CredentialDispatchInput,
  CredentialProvider,
  IronClawAdapter,
} from '@skytwin/ironclaw-adapter';
import {
  ActionHandlerRegistry,
  DirectExecutionAdapter,
  EmailActionHandler,
} from '@skytwin/ironclaw-adapter';
import {
  ExecutionRouter,
  AmbiguousExecutionError,
  NoAdapterError,
  InvariantViolationError,
} from '../execution-router.js';
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
    // archive_email + user_originated: reversible, non-destructive, trusted
    // provenance — so the execution-router injection-guard backstop does not
    // fire, keeping these tests focused on routing/fallback mechanics. The
    // backstop itself is covered by injection-guard-backstop.test.ts. The
    // `route()`-only tests below override actionType where they need to.
    actionType: 'archive_email',
    description: 'Archive an email',
    domain: 'email',
    parameters: { messageId: 'msg-1' },
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'User typically archives newsletters',
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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
        status: 'completed' as const,
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
 * Adapter that throws after it has been invoked. The router cannot prove
 * whether an effect happened, so this must never trigger fallback.
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
      throw new Error(`${name} execution response was ambiguous`);
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

    it('replaces every adapter-supplied reserved output fact with router authority', async () => {
      const hostile = createMockAdapter('ironclaw');
      hostile.execute = vi.fn(async (plan): Promise<ExecutionResult> => ({
        planId: plan.id,
        status: 'completed' as const,
        startedAt: new Date(),
        completedAt: new Date(),
        output: {
          provider_result: 'retained until the persistence normalizer',
          adapter_used: 'hostile',
          routing_decision: 'hostile',
          fallbacks_attempted: 99,
          fallback_skipped_reason: 'previous adapter returned non-completed status, fallback unsafe',
          adapter_plan_id: 'hostile-plan',
          status: 'failed',
          success: false,
          rollback_available: true,
        },
      }));
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);

      const result = await router.executeWithRouting(makeAction(), makeRiskAssessment(), 'user-1');

      expect(result.output).toMatchObject({
        provider_result: 'retained until the persistence normalizer',
        adapter_used: 'ironclaw',
        routing_decision: 'ironclaw',
        fallbacks_attempted: 0,
        adapter_plan_id: result.planId,
        status: 'completed',
        success: true,
        rollback_available: false,
      });
      expect(result.output).not.toHaveProperty('fallback_skipped_reason');
    });

    it('replaces reserved output facts in the non-stream adapter streaming fallback', async () => {
      const hostile = createMockAdapter('ironclaw');
      hostile.execute = vi.fn(async (plan): Promise<ExecutionResult> => ({
        planId: plan.id,
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        output: {
          adapter_used: 'forged', adapter_plan_id: 'forged-plan',
          status: 'failed', success: false, rollback_available: true,
        },
      }));
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);

      const events: ExecutionEvent[] = [];
      for await (const event of router.executeWithRoutingStreaming(
        makeAction(), makeRiskAssessment(), 'user-1',
      )) events.push(event);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        adapter_used: 'ironclaw', adapter_plan_id: 'ironclaw_plan_1',
        status: 'completed', success: true, rollback_available: false,
      });
    });

    it('does not fall back after any adapter-originated exception', async () => {
      registry.register('ironclaw', createThrowingAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);
      const fallback = createMockAdapter('direct');
      const fallbackExecute = vi.spyOn(fallback, 'execute');
      registry.register('direct', fallback, DIRECT_TRUST_PROFILE);

      const action = makeAction();
      const risk = makeRiskAssessment();

      await expect(router.executeWithRouting(action, risk, 'user-1'))
        .rejects.toThrow('ambiguous');
      expect(fallbackExecute).not.toHaveBeenCalled();
    });

    it('rejects terminal truth for a different built plan without fallback', async () => {
      const hostile = createMockAdapter('ironclaw');
      hostile.execute = vi.fn(async () => ({
        planId: 'opaque-different-plan',
        status: 'completed' as const,
        startedAt: new Date(),
        completedAt: new Date(),
      }));
      const fallback = createMockAdapter('direct');
      const fallbackExecute = vi.spyOn(fallback, 'execute');
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);
      registry.register('direct', fallback, DIRECT_TRUST_PROFILE);

      await expect(router.executeWithRouting(makeAction(), makeRiskAssessment(), 'user-1'))
        .rejects.toBeInstanceOf(AmbiguousExecutionError);
      expect(fallbackExecute).not.toHaveBeenCalled();
    });

    it('rejects an adapter-built id that differs from the admitted plan before execute', async () => {
      const hostile = createMockAdapter('ironclaw');
      const execute = vi.spyOn(hostile, 'execute');
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);
      const action = makeAction({
        parameters: { executionPlanId: 'trusted-admitted-plan' },
      });

      await expect(router.executeWithRouting(action, makeRiskAssessment(), 'user-1'))
        .rejects.toBeInstanceOf(AmbiguousExecutionError);
      expect(execute).not.toHaveBeenCalled();
    });

    it.each(['pending', 'running'] as const)(
      'rejects a synchronous %s result as ambiguous without fallback',
      async (status) => {
        const ambiguous = createMockAdapter('ironclaw');
        ambiguous.execute = vi.fn(async (plan) => ({
          planId: plan.id,
          status,
          startedAt: new Date(),
        }));
        const fallback = createMockAdapter('direct');
        const fallbackExecute = vi.spyOn(fallback, 'execute');
        registry.register('ironclaw', ambiguous, IRONCLAW_TRUST_PROFILE);
        registry.register('direct', fallback, DIRECT_TRUST_PROFILE);

        await expect(router.executeWithRouting(makeAction(), makeRiskAssessment(), 'user-1'))
          .rejects.toBeInstanceOf(AmbiguousExecutionError);
        expect(fallbackExecute).not.toHaveBeenCalled();
      },
    );

    it('surfaces the first adapter error without trying the rest', async () => {
      registry.register('ironclaw', createThrowingAdapter('ironclaw'), IRONCLAW_TRUST_PROFILE);
      registry.register('direct', createThrowingAdapter('direct'), DIRECT_TRUST_PROFILE);

      const action = makeAction();
      const risk = makeRiskAssessment();

      await expect(router.executeWithRouting(action, risk, 'user-1'))
        .rejects.toThrow('ironclaw execution response was ambiguous');
    });

    it('does not fall back when an adapter commits and then throws ambiguously', async () => {
      let committed = false;
      const hostile = createMockAdapter('ironclaw');
      hostile.execute = vi.fn(async () => {
        committed = true;
        throw new InvariantViolationError('response lost after commit');
      });
      const fallback = createMockAdapter('direct');
      const fallbackExecute = vi.spyOn(fallback, 'execute');
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);
      registry.register('direct', fallback, DIRECT_TRUST_PROFILE);

      await expect(router.executeWithRouting(makeAction(), makeRiskAssessment(), 'user-1'))
        .rejects.toThrow('response lost after commit');
      expect(committed).toBe(true);
      expect(fallbackExecute).not.toHaveBeenCalled();
    });

    it('does not stream through a fallback after an ambiguous commit-then-throw', async () => {
      const hostile = createMockAdapter('ironclaw') as IronClawAdapter & {
        executeStreaming(plan: ExecutionPlan): AsyncIterable<never>;
      };
      hostile.executeStreaming = async function* () {
        throw new Error('stream response lost after commit');
      };
      const fallback = createMockAdapter('direct');
      const fallbackExecute = vi.spyOn(fallback, 'execute');
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);
      registry.register('direct', fallback, DIRECT_TRUST_PROFILE);

      const stream = router.executeWithRoutingStreaming(makeAction(), makeRiskAssessment(), 'user-1');
      await expect((async () => {
        for await (const _event of stream) {
          // consume
        }
      })()).rejects.toThrow('stream response lost after commit');
      expect(fallbackExecute).not.toHaveBeenCalled();
    });

    it('does not fabricate completion when a streaming adapter ends cleanly without terminal truth', async () => {
      const hostile = createMockAdapter('ironclaw') as IronClawAdapter & {
        executeStreaming(plan: ExecutionPlan): AsyncIterable<ExecutionEvent>;
      };
      hostile.executeStreaming = async function* (plan) {
        yield { planId: plan.id, eventType: 'plan_started', timestamp: new Date() };
      };
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);

      const stream = router.executeWithRoutingStreaming(makeAction(), makeRiskAssessment(), 'user-1');
      await expect((async () => {
        for await (const _event of stream) {
          // consume
        }
      })()).rejects.toThrow('without an explicit terminal event');
    });

    it('rejects a streaming event for a different built plan before publishing it', async () => {
      const hostile = createMockAdapter('ironclaw') as IronClawAdapter & {
        executeStreaming(plan: ExecutionPlan): AsyncIterable<ExecutionEvent>;
      };
      hostile.executeStreaming = async function* () {
        yield { planId: 'opaque-different-plan', eventType: 'plan_completed', timestamp: new Date() };
      };
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);
      const published: ExecutionEvent[] = [];

      const stream = router.executeWithRoutingStreaming(makeAction(), makeRiskAssessment(), 'user-1');
      await expect((async () => {
        for await (const event of stream) published.push(event);
      })()).rejects.toThrow('different execution plan');
      expect(published).toEqual([]);
    });

    it('rejects a token-shaped adapter step id before publishing it', async () => {
      const hostile = createMockAdapter('ironclaw') as IronClawAdapter & {
        executeStreaming(plan: ExecutionPlan): AsyncIterable<ExecutionEvent>;
      };
      hostile.executeStreaming = async function* (plan) {
        yield {
          planId: plan.id,
          stepId: 'ya29.adapter-secret',
          eventType: 'step_started',
          timestamp: new Date(),
        };
      };
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);
      const published: ExecutionEvent[] = [];

      const stream = router.executeWithRoutingStreaming(makeAction(), makeRiskAssessment(), 'user-1');
      await expect((async () => {
        for await (const event of stream) published.push(event);
      })()).rejects.toThrow('unbound step identity');
      expect(published).toEqual([]);
    });

    it('rejects a valid later-step identity used for the current step', async () => {
      const hostile = createMockAdapter('ironclaw') as IronClawAdapter & {
        executeStreaming(plan: ExecutionPlan): AsyncIterable<ExecutionEvent>;
      };
      hostile.buildPlan = vi.fn(async (action: CandidateAction) => ({
        id: 'ironclaw_plan_1', decisionId: action.decisionId, action,
        steps: [1, 2].map((order) => ({
          id: `adapter-step-${order}`, order, type: action.actionType,
          description: action.description, parameters: action.parameters, timeout: 30_000,
        })),
        rollbackSteps: [], createdAt: new Date(),
      }));
      hostile.executeStreaming = async function* (plan) {
        yield {
          planId: plan.id,
          stepId: plan.steps[1]!.id,
          eventType: 'step_started',
          timestamp: new Date(),
        };
      };
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);

      const stream = router.executeWithRoutingStreaming(makeAction(), makeRiskAssessment(), 'user-1');
      await expect((async () => {
        for await (const _event of stream) { /* consume */ }
      })()).rejects.toThrow('unbound step identity');
    });

    it('rejects conflicting terminal events without publishing either terminal result', async () => {
      const hostile = createMockAdapter('ironclaw') as IronClawAdapter & {
        executeStreaming(plan: ExecutionPlan): AsyncIterable<ExecutionEvent>;
      };
      hostile.executeStreaming = async function* (plan) {
        yield { planId: plan.id, eventType: 'plan_completed', timestamp: new Date() };
        yield { planId: plan.id, eventType: 'plan_failed', timestamp: new Date() };
      };
      registry.register('ironclaw', hostile, IRONCLAW_TRUST_PROFILE);
      const published: ExecutionEvent[] = [];

      const stream = router.executeWithRoutingStreaming(makeAction(), makeRiskAssessment(), 'user-1');
      await expect((async () => {
        for await (const event of stream) published.push(event);
      })()).rejects.toThrow('event after terminal plan_completed');
      expect(published).toEqual([]);
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
      vi.spyOn(ironclaw, 'rollback').mockRejectedValue(new Error('boom'));
      registry.register('ironclaw', ironclaw, IRONCLAW_TRUST_PROFILE);

      const out = await router.rollback('plan-1', 'ironclaw');

      expect(out.noAdapter).toBe(false);
      expect(out.result.success).toBe(false);
      expect(out.result.message).toBe('The recorded adapter rollback outcome is unavailable.');
      expect(out.adapterUsed).toBe('ironclaw');
    });

    it('does not expose the adapter\'s own rollback failure text', async () => {
      const ironclaw = createMockAdapter('ironclaw');
      vi.spyOn(ironclaw, 'rollback').mockResolvedValue({
        success: false,
        message: 'ya29.adapter-secret',
      });
      registry.register('ironclaw', ironclaw, IRONCLAW_TRUST_PROFILE);

      const out = await router.rollback('plan-1', 'ironclaw');

      expect(out.noAdapter).toBe(false);
      expect(out.result.success).toBe(false);
      expect(out.result.message).toBe('The recorded adapter could not confirm rollback completion.');
      expect(out.result.message).not.toContain('ya29.adapter-secret');
    });
  });

  describe('credential request-start boundary', () => {
    class PausingDirectAdapter extends DirectExecutionAdapter {
      constructor(
        handlers: ActionHandlerRegistry,
        private readonly reached: { resolve: () => void },
        private readonly release: Promise<void>,
      ) {
        super(handlers);
      }

      override async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
        const plan = await super.buildPlan(action);
        this.reached.resolve();
        await this.release;
        return plan;
      }
    }

    function setupCredentialDispatch(initial: string) {
      let state: string | null = initial;
      let authorityRevision = 'authority-revision-1';
      let policyAuthorityRevision = 'policy-revision-1';
      const starts: CredentialDispatchInput[] = [];
      const provider: CredentialProvider = {
        async getAccessToken() {
          return state
            ? { success: true as const, accessToken: state }
            : { success: false as const, error: 'disconnected' };
        },
        async startDispatch(input) {
          starts.push(input);
          return state && input.authorityRevision === authorityRevision &&
              input.policyAuthorityRevision === policyAuthorityRevision
            ? {
                success: true as const,
                accessToken: state,
                capability: 'lease-capability',
                leaseGeneration: 'lease-generation',
                executionPlanId: input.executionPlanId,
                userId: input.userId,
              }
            : { success: false as const, error: state ? 'authority changed' : 'disconnected' };
        },
        async terminalizeDispatch() { return true; },
      };
      return {
        provider,
        starts,
        setState: (next: string | null) => { state = next; },
        setAuthority: (next: string) => { authorityRevision = next; },
        setPolicyAuthority: (next: string) => { policyAuthorityRevision = next; },
      };
    }

    function directRouter(provider: CredentialProvider, reached: { resolve: () => void }, release: Promise<void>) {
      const handlers = new ActionHandlerRegistry();
      handlers.register(new EmailActionHandler(provider));
      const localRegistry = new AdapterRegistry();
      localRegistry.register(
        'direct',
        new PausingDirectAdapter(handlers, reached, release),
        DIRECT_TRUST_PROFILE,
        new Set(['archive_email']),
      );
      return new ExecutionRouter(localRegistry);
    }

    it('binds the trusted owner and current token after an awaited build, then sends once', async () => {
      const buildReached = deferred();
      const buildRelease = deferred();
      const credentials = setupCredentialDispatch('old-token');
      const localRouter = directRouter(credentials.provider, buildReached, buildRelease.promise);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
      const action = makeAction({
        id: '11111111-1111-4111-8111-111111111111',
        decisionId: '22222222-2222-4222-8222-222222222222',
        parameters: {
          emailId: 'message-1',
          executionPlanId: '33333333-3333-4333-8333-333333333333',
          credentialAuthorityRevision: 'authority-revision-1',
          credentialPolicyAuthorityRevision: 'policy-revision-1',
          userId: 'spoofed-owner',
          accessToken: 'stale-token',
        },
      });
      const risk = makeRiskAssessment({ actionId: action.id });

      const resultPromise = localRouter.executeWithRouting(action, risk, 'trusted-owner');
      await buildReached.promise;
      credentials.setState('new-token');
      buildRelease.resolve();
      await expect(resultPromise).resolves.toMatchObject({ status: 'completed' });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]![1]).toMatchObject({
        headers: { Authorization: 'Bearer new-token' },
      });
      expect(credentials.starts[0]).toMatchObject({
        userId: 'trusted-owner',
        actionId: action.id,
        decisionId: action.decisionId,
        executionPlanId: '33333333-3333-4333-8333-333333333333',
      });
      expect(action.parameters).toMatchObject({ userId: 'spoofed-owner', accessToken: 'stale-token' });
      fetchSpy.mockRestore();
    });

    it.each(['trust', 'policy'] as const)(
      'loses a %s-authority change during build without issuing an adapter request',
      async (kind) => {
        const buildReached = deferred();
        const buildRelease = deferred();
        const credentials = setupCredentialDispatch('old-token');
        const localRouter = directRouter(credentials.provider, buildReached, buildRelease.promise);
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
        const action = makeAction({
          id: '11111111-1111-4111-8111-111111111111',
          decisionId: '22222222-2222-4222-8222-222222222222',
          parameters: {
            emailId: 'message-1',
            executionPlanId: '33333333-3333-4333-8333-333333333333',
            credentialAuthorityRevision: 'authority-revision-1',
            credentialPolicyAuthorityRevision: 'policy-revision-1',
          },
        });
        const risk = makeRiskAssessment({ actionId: action.id });
        const resultPromise = localRouter.executeWithRouting(action, risk, 'trusted-owner');
        await buildReached.promise;
        if (kind === 'trust') credentials.setAuthority('authority-revision-2');
        else credentials.setPolicyAuthority('policy-revision-2');
        buildRelease.resolve();

        await expect(resultPromise).rejects.toThrow('authority changed');
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      },
    );

    it('loses a streaming disconnect race without issuing an adapter request', async () => {
      const buildReached = deferred();
      const buildRelease = deferred();
      const credentials = setupCredentialDispatch('old-token');
      const localRouter = directRouter(credentials.provider, buildReached, buildRelease.promise);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
      const action = makeAction({
        id: '11111111-1111-4111-8111-111111111111',
        decisionId: '22222222-2222-4222-8222-222222222222',
        parameters: {
          emailId: 'message-1',
          executionPlanId: '33333333-3333-4333-8333-333333333333',
          credentialAuthorityRevision: 'authority-revision-1',
          credentialPolicyAuthorityRevision: 'policy-revision-1',
        },
      });
      const risk = makeRiskAssessment({ actionId: action.id });
      const collect = (async () => {
        for await (const _event of localRouter.executeWithRoutingStreaming(
          action, risk, 'trusted-owner',
        )) { /* consume */ }
      })();
      await buildReached.promise;
      credentials.setState(null);
      buildRelease.resolve();
      await expect(collect).rejects.toThrow('disconnected');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });
});
