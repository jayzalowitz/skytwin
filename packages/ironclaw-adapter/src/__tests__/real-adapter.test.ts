import { afterEach, describe, it, expect, vi } from 'vitest';
import { DirectExecutionAdapter } from '../direct-execution-adapter.js';
import { RealIronClawAdapter } from '../real-adapter.js';
import { PreRequestExecutionError } from '../ironclaw-adapter.js';
import { ActionHandlerRegistry } from '../handler-registry.js';
import type { CandidateAction, ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

/** Test handler that always succeeds for test_action type. */
class TestActionHandler implements ActionHandler {
  readonly actionType = 'test_action';
  readonly domain = 'testing';
  canHandle(actionType: string): boolean { return actionType === 'test_action'; }
  async execute(_step: ExecutionStep): Promise<StepResult> {
    return { success: true, output: { test: true } };
  }
  async rollback(_step: ExecutionStep): Promise<StepResult> {
    return { success: true, output: { rollback: true } };
  }
}

class NoRollbackActionHandler extends TestActionHandler {
  readonly supportsRollback = false;
}

class SlowActionHandler implements ActionHandler {
  readonly actionType = 'test_action';
  readonly domain = 'testing';
  committed = false;
  canHandle(actionType: string): boolean { return actionType === 'test_action'; }
  async execute(_step: ExecutionStep): Promise<StepResult> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.committed = true;
    return { success: true };
  }
  async rollback(_step: ExecutionStep): Promise<StepResult> {
    return { success: true };
  }
}

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'act_1',
    decisionId: 'dec_1',
    actionType: 'test_action',
    description: 'Test action',
    domain: 'test',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Test',
    ...overrides,
  };
}

describe('DirectExecutionAdapter', () => {
  it('builds a plan from a candidate action', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const action = makeAction();
    const plan = await adapter.buildPlan(action);

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.type).toBe('test_action');
    expect(plan.rollbackSteps).toHaveLength(1); // reversible action
  });

  it('does not create rollback steps for irreversible actions', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const action = makeAction({ reversible: false });
    const plan = await adapter.buildPlan(action);

    expect(plan.rollbackSteps).toHaveLength(0);
  });

  it('does not advertise rollback when the selected handler lacks rollback authority', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new NoRollbackActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction({ reversible: true }));
    expect(plan.rollbackSteps).toEqual([]);
    const result = await adapter.execute(plan);
    expect(result.output?.['rollback_available']).toBe(false);
    await expect(adapter.rollback(plan.id)).resolves.toMatchObject({ success: false });
  });

  it('executes a plan using the handler', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    const result = await adapter.execute(plan);

    expect(result.status).toBe('completed');
    expect(result.output).toBeDefined();
  });

  it('tracks execution status for completed plans', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    await adapter.execute(plan);

    await expect(adapter.getStatus(plan.id)).resolves.toBe('completed');
    await expect(adapter.getStatus('missing-plan')).rejects.toThrow('No executed plan');
  });

  it('streams per-step execution events', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    const events: string[] = [];
    for await (const event of adapter.executeStreaming(plan)) {
      events.push(event.eventType);
    }

    expect(events).toEqual(['plan_started', 'step_started', 'step_completed', 'plan_completed']);
  });

  it('leaves a timed-out handler ambiguous when it can still commit later', async () => {
    const registry = new ActionHandlerRegistry();
    const handler = new SlowActionHandler();
    registry.register(handler);
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    plan.steps[0]!.timeout = 5;

    await expect(adapter.execute(plan)).rejects.toThrow('outcome is ambiguous');
    await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handler.committed).toBe(true);
    await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
  });

  it('refuses during plan preflight when no handler is registered', async () => {
    const registry = new ActionHandlerRegistry(); // empty
    const adapter = new DirectExecutionAdapter(registry);

    await expect(adapter.buildPlan(makeAction())).rejects.toThrow('No handler');
  });

  it('supports rollback for executed plans', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const plan = await adapter.buildPlan(makeAction());
    await adapter.execute(plan);

    const rollbackResult = await adapter.rollback(plan.id);
    expect(rollbackResult.success).toBe(true);
  });

  it('healthCheck returns healthy when handlers are registered', async () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new TestActionHandler());
    const adapter = new DirectExecutionAdapter(registry);

    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(true);
  });

  it('healthCheck returns unhealthy when no handlers', async () => {
    const registry = new ActionHandlerRegistry();
    const adapter = new DirectExecutionAdapter(registry);

    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
  });
});

describe('RealIronClawAdapter request preflight', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports a known-unavailable execution circuit before building a plan', async () => {
    const adapter = new RealIronClawAdapter({
      apiUrl: 'http://127.0.0.1:9999',
      webhookSecret: 'test-secret',
      ownerId: 'owner-1',
    });
    const client = (adapter as unknown as {
      client: { ensureExecutionEndpointReady(streaming?: boolean): Promise<void> };
    }).client;
    vi.spyOn(client, 'ensureExecutionEndpointReady').mockRejectedValueOnce(
      new Error('known open circuit'),
    );

    await expect(adapter.buildPlan(makeAction())).rejects.toBeInstanceOf(
      PreRequestExecutionError,
    );
  });

  it('preflights the webhook endpoint for streaming execution', async () => {
    const adapter = new RealIronClawAdapter({
      apiUrl: 'http://127.0.0.1:9999', webhookSecret: 'test-secret', ownerId: 'owner-1',
      preferChatCompletions: true,
    });
    const client = (adapter as unknown as {
      client: { ensureExecutionEndpointReady(streaming?: boolean): Promise<void> };
    }).client;
    const preflight = vi.spyOn(client, 'ensureExecutionEndpointReady').mockResolvedValue();

    await adapter.buildPlan(makeAction(), { streaming: true });
    expect(preflight).toHaveBeenCalledWith(true);
  });

  it('uses its single-use preflight proof without another await before the effect POST', async () => {
    const adapter = new RealIronClawAdapter({
      apiUrl: 'http://127.0.0.1:9999', webhookSecret: 'test-secret', ownerId: 'owner-1',
    });
    const client = (adapter as unknown as {
      client: { ensureExecutionEndpointReady(streaming?: boolean): Promise<void> };
    }).client;
    const preflight = vi.spyOn(client, 'ensureExecutionEndpointReady').mockResolvedValue();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: 'done', metadata: { status: 'completed', success: true },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const plan = await adapter.buildPlan(makeAction(), { streaming: false });
    const preparation = await adapter.prepareRequestStart(plan, { streaming: false });
    preflight.mockRejectedValue(new Error('post-lease circuit check must not run'));

    await expect(adapter.execute(plan, preparation)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(adapter.execute(plan, preparation)).rejects.toThrow(
      'invalid or already consumed',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves and binds the configured default channel before request start', async () => {
    const adapter = new RealIronClawAdapter({
      apiUrl: 'http://127.0.0.1:9999',
      webhookSecret: 'test-secret',
      ownerId: 'owner-1',
      defaultChannel: 'configured-default-channel',
    });
    const client = (adapter as unknown as {
      client: { ensureExecutionEndpointReady(streaming?: boolean): Promise<void> };
    }).client;
    vi.spyOn(client, 'ensureExecutionEndpointReady').mockResolvedValue();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: 'done', metadata: { status: 'completed', success: true },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const plan = await adapter.buildPlan(makeAction(), { streaming: false });
    const preparation = await adapter.prepareRequestStart(plan, { streaming: false });
    expect(preparation.executionChannel).toBe('configured-default-channel');
    plan.executionChannel = preparation.executionChannel;
    await adapter.execute(plan, preparation);

    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      channel: 'configured-default-channel',
    });
  });

  it('rejects a preflight proof used for the wrong execution mode before POST', async () => {
    const adapter = new RealIronClawAdapter({
      apiUrl: 'http://127.0.0.1:9999', webhookSecret: 'test-secret', ownerId: 'owner-1',
    });
    const client = (adapter as unknown as {
      client: { ensureExecutionEndpointReady(streaming?: boolean): Promise<void> };
    }).client;
    vi.spyOn(client, 'ensureExecutionEndpointReady').mockResolvedValue();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const plan = await adapter.buildPlan(makeAction(), { streaming: true });
    const preparation = await adapter.prepareRequestStart(plan, { streaming: true });
    await expect(adapter.execute(plan, preparation)).rejects.toThrow(
      'invalid or already consumed',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses router-authored owner/channel only in the envelope', async () => {
    const adapter = new RealIronClawAdapter({
      apiUrl: 'http://127.0.0.1:9999', webhookSecret: 'test-secret', ownerId: 'owner-1',
    });
    const client = (adapter as unknown as {
      client: { ensureExecutionEndpointReady(streaming?: boolean): Promise<void> };
    }).client;
    vi.spyOn(client, 'ensureExecutionEndpointReady').mockResolvedValue();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: 'done', metadata: { status: 'completed', success: true },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const plan = await adapter.buildPlan(makeAction({
      parameters: {
        userId: 'candidate-owner', ironclawChannel: 'candidate-channel', value: 'safe',
        nested: {
          userId: 'nested-spoof',
          accessToken: 'nested-access-secret',
          note: 'Bearer nested-bearer-secret',
        },
        list: [
          { Authorization: 'Bearer array-secret' },
          'ya29.recognizable-token-secret',
        ],
      },
    }));
    plan.executionOwnerId = 'trusted-owner';
    plan.executionChannel = 'trusted-channel';

    await adapter.execute(plan);
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    expect(body['user_id']).toBe('trusted-owner');
    expect(body['channel']).toBe('trusted-channel');
    const metadata = body['metadata'] as Record<string, unknown>;
    const action = metadata['action'] as Record<string, unknown>;
    expect(action['parameters']).toMatchObject({
      value: 'safe',
      nested: {
        accessToken_ref: '[managed-by-ironclaw]',
        note: 'Bearer [managed-by-ironclaw]',
      },
      list: [
        { Authorization_ref: '[managed-by-ironclaw]' },
        '[managed-by-ironclaw]',
      ],
    });
    expect((action['parameters'] as { nested: Record<string, unknown> }).nested)
      .not.toHaveProperty('userId');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/candidate-owner|candidate-channel|nested-spoof|nested-access-secret|nested-bearer-secret|array-secret|ya29\./);
  });
});
