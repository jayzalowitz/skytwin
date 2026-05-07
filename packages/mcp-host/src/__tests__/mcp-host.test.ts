import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '@skytwin/core';
import { ConfidenceLevel } from '@skytwin/shared-types';
import { McpHost } from '../mcp-host.js';
import type { McpServerConfig } from '../types.js';
import type { CandidateAction } from '@skytwin/shared-types';

// ---------------------------------------------------------------------------
// Fake MCP Client
//
// Mirrors only the Client methods McpHost calls:
//   connect, close, ping, listTools, callTool
// ---------------------------------------------------------------------------

interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface FakeClientOpts {
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  callToolResult?: Record<string, unknown> | Error;
  pingError?: boolean;
}

function makeFakeClient(opts: FakeClientOpts = {}) {
  const calls: FakeToolCall[] = [];
  const defaultTools = [
    { name: 'send_email', description: 'Send an email' },
    { name: 'send_email_undo', description: 'Undo a sent email' },
    { name: 'create_event', description: 'Create a calendar event' },
  ];
  const tools = opts.tools ?? defaultTools;

  return {
    _calls: calls,
    async connect(_transport: unknown): Promise<void> {},
    async close(): Promise<void> {},
    async ping(): Promise<void> {
      if (opts.pingError) throw new Error('ping failed');
    },
    async listTools(): Promise<{ tools: typeof tools }> {
      return { tools };
    },
    async callTool(params: {
      name: string;
      arguments?: Record<string, unknown>;
    }): Promise<unknown> {
      calls.push({ name: params.name, args: params.arguments ?? {} });
      if (opts.callToolResult instanceof Error) throw opts.callToolResult;
      return opts.callToolResult ?? { ok: true };
    },
  };
}

type FakeClient = ReturnType<typeof makeFakeClient>;

// ---------------------------------------------------------------------------
// Test injection helper
//
// McpHost.installServer creates real SDK clients. For unit tests we bypass
// that by injecting a pre-wired ServerEntry directly into the private Map.
// This is the standard vitest/jest pattern for testing private state via
// casting — no test doubles in production code.
// ---------------------------------------------------------------------------

interface InternalServerEntry {
  config: McpServerConfig;
  handle: {
    id: string;
    status: 'starting' | 'running' | 'failed' | 'stopped';
    startedAt?: Date;
    lastError?: string;
  };
  client: FakeClient;
  circuit: CircuitBreaker;
  stop: () => void;
}

function injectFakeServer(host: McpHost, config: McpServerConfig, client: FakeClient): void {
  const circuit = new CircuitBreaker(`mcp:${config.id}`, {
    failureThreshold: 3,
    resetTimeoutMs: 60_000,
  });
  const entry: InternalServerEntry = {
    config,
    handle: { id: config.id, status: 'running', startedAt: new Date() },
    client,
    circuit,
    stop: () => {},
  };
  const internalServers = (host as unknown as { servers: Map<string, InternalServerEntry> })
    .servers;
  internalServers.set(config.id, entry);
}

// ---------------------------------------------------------------------------
// Sample action factory
// ---------------------------------------------------------------------------

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  const { parameters: paramOverrides, ...rest } = overrides;
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    actionType: 'send_email',
    description: 'Send a test email',
    domain: 'email',
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'unit test',
    ...rest,
    parameters: {
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'World',
      ...(paramOverrides ?? {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpHost', () => {
  let host: McpHost;
  let fakeClient: FakeClient;

  const serverConfig: McpServerConfig = {
    id: 'test-server',
    transport: 'stdio',
    command: 'node',
    args: ['fake-server.js'],
  };

  beforeEach(() => {
    host = new McpHost();
    fakeClient = makeFakeClient();
    injectFakeServer(host, serverConfig, fakeClient);
  });

  // ── listServers ──────────────────────────────────────────────────────────

  it('listServers returns the injected server', () => {
    const servers = host.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe('test-server');
    expect(servers[0]?.status).toBe('running');
  });

  // ── transport selection by config shape ──────────────────────────────────

  it('McpServerConfig with stdio transport carries command + args', () => {
    const cfg: McpServerConfig = {
      id: 'stdio-server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      resourceLimits: { memoryMb: 512 },
    };
    expect(cfg.transport).toBe('stdio');
    expect(cfg.command).toBe('npx');
    expect(cfg.resourceLimits?.memoryMb).toBe(512);
    expect(cfg.url).toBeUndefined();
  });

  it('McpServerConfig with http transport carries url, no command', () => {
    const cfg: McpServerConfig = {
      id: 'http-server',
      transport: 'http',
      url: 'http://localhost:3030/mcp',
    };
    expect(cfg.transport).toBe('http');
    expect(cfg.url).toBeDefined();
    expect(cfg.command).toBeUndefined();
  });

  it('McpServerConfig with sse transport carries url, no command', () => {
    const cfg: McpServerConfig = {
      id: 'sse-server',
      transport: 'sse',
      url: 'http://localhost:3031/sse',
    };
    expect(cfg.transport).toBe('sse');
    expect(cfg.url).toBeDefined();
    expect(cfg.command).toBeUndefined();
  });

  // ── buildPlan ────────────────────────────────────────────────────────────

  it('buildPlan selects the running server and encodes _mcpServerId/_mcpToolName', async () => {
    const plan = await host.buildPlan(makeAction());

    expect(plan.id).toMatch(/^mcp_plan_/);
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.parameters['_mcpServerId']).toBe('test-server');
    expect(step.parameters['_mcpToolName']).toBe('send_email');
  });

  it('buildPlan respects mcpServerId/mcpToolName from action.parameters', async () => {
    const action = makeAction({
      parameters: { mcpServerId: 'custom-server', mcpToolName: 'my_tool' },
    });
    const plan = await host.buildPlan(action);
    const step = plan.steps[0]!;
    expect(step.parameters['_mcpServerId']).toBe('custom-server');
    expect(step.parameters['_mcpToolName']).toBe('my_tool');
  });

  it('buildPlan includes rollback step for reversible actions', async () => {
    const plan = await host.buildPlan(makeAction({ reversible: true }));
    expect(plan.rollbackSteps).toHaveLength(1);
    expect(plan.rollbackSteps[0]?.parameters['_isRollback']).toBe(true);
  });

  it('buildPlan omits rollback step for irreversible actions', async () => {
    const plan = await host.buildPlan(makeAction({ reversible: false }));
    expect(plan.rollbackSteps).toHaveLength(0);
  });

  // ── execute ──────────────────────────────────────────────────────────────

  it('execute calls the MCP tool and returns completed', async () => {
    const plan = await host.buildPlan(makeAction());
    const result = await host.execute(plan);

    expect(result.status).toBe('completed');
    expect(result.planId).toBe(plan.id);
    expect(fakeClient._calls).toHaveLength(1);
    expect(fakeClient._calls[0]?.name).toBe('send_email');
  });

  it('execute strips _mcp* internal keys from tool arguments', async () => {
    const plan = await host.buildPlan(makeAction());
    await host.execute(plan);

    const args = fakeClient._calls[0]?.args ?? {};
    const keys = Object.keys(args);
    expect(keys.some((k) => k.startsWith('_mcp'))).toBe(false);
  });

  it('execute returns failed when the tool throws', async () => {
    const failClient = makeFakeClient({ callToolResult: new Error('tool exploded') });
    const cfg: McpServerConfig = { id: 'fail-server', transport: 'stdio', command: 'node' };
    injectFakeServer(host, cfg, failClient);

    const action = makeAction({
      parameters: { mcpServerId: 'fail-server', mcpToolName: 'send_email' },
    });
    const plan = await host.buildPlan(action);
    const result = await host.execute(plan);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('tool exploded');
  });

  it('execute returns failed for missing _mcpServerId (plan not via buildPlan)', async () => {
    const plan = await host.buildPlan(makeAction());
    delete (plan.steps[0]!.parameters as Record<string, unknown>)['_mcpServerId'];
    const result = await host.execute(plan);
    expect(result.status).toBe('failed');
  });

  // ── onToolCall observability hook (#183) ─────────────────────────────────

  it('onToolCall fires after a successful tool call with success:true', async () => {
    const events: Array<{ serverId: string; toolName: string; success: boolean }> = [];
    const observedHost = new McpHost({
      onToolCall: (e) => {
        events.push({ serverId: e.serverId, toolName: e.toolName, success: e.success });
      },
    });
    const observedClient = makeFakeClient();
    injectFakeServer(observedHost, serverConfig, observedClient);

    const plan = await observedHost.buildPlan(makeAction());
    await observedHost.execute(plan);

    expect(events).toHaveLength(1);
    expect(events[0]?.serverId).toBe('test-server');
    expect(events[0]?.toolName).toBe('send_email');
    expect(events[0]?.success).toBe(true);
  });

  it('onToolCall fires with success:false when the tool throws', async () => {
    const events: Array<{ success: boolean }> = [];
    const observedHost = new McpHost({
      onToolCall: (e) => {
        events.push({ success: e.success });
      },
    });
    const failClient = makeFakeClient({ callToolResult: new Error('tool exploded') });
    const cfg: McpServerConfig = { id: 'fail-server', transport: 'stdio', command: 'node' };
    injectFakeServer(observedHost, cfg, failClient);

    const action = makeAction({
      parameters: { mcpServerId: 'fail-server', mcpToolName: 'send_email' },
    });
    const plan = await observedHost.buildPlan(action);
    await observedHost.execute(plan);

    expect(events).toHaveLength(1);
    expect(events[0]?.success).toBe(false);
  });

  it('onToolCall errors do not block execution', async () => {
    const observedHost = new McpHost({
      onToolCall: () => {
        throw new Error('observability blew up');
      },
    });
    const observedClient = makeFakeClient();
    injectFakeServer(observedHost, serverConfig, observedClient);

    const plan = await observedHost.buildPlan(makeAction());
    const result = await observedHost.execute(plan);

    expect(result.status).toBe('completed');
  });

  // ── getStatus ────────────────────────────────────────────────────────────

  it('getStatus reflects completed after a successful execute', async () => {
    const plan = await host.buildPlan(makeAction());
    await host.execute(plan);
    const status = await host.getStatus(plan.id);
    expect(status).toBe('completed');
  });

  it('getStatus throws for unknown planId', async () => {
    await expect(host.getStatus('nonexistent-plan')).rejects.toThrow('No execution found');
  });

  // ── rollback heuristic ───────────────────────────────────────────────────

  it('rollback finds send_email_undo via _undo heuristic', async () => {
    const plan = await host.buildPlan(makeAction({ reversible: true }));
    await host.execute(plan);

    const result = await host.rollback(plan.id);

    expect(result.success).toBe(true);
    expect(result.message).toContain('send_email_undo');

    const undoCall = fakeClient._calls.find((c) => c.name === 'send_email_undo');
    expect(undoCall).toBeDefined();
  });

  it('rollback returns no rollback available when no undo tool exists', async () => {
    const noUndoClient = makeFakeClient({
      tools: [{ name: 'unique_action', description: 'One-way action' }],
    });
    const cfg: McpServerConfig = { id: 'no-undo-server', transport: 'stdio', command: 'node' };
    injectFakeServer(host, cfg, noUndoClient);

    const action = makeAction({
      actionType: 'unique_action',
      reversible: true,
      parameters: { mcpServerId: 'no-undo-server', mcpToolName: 'unique_action' },
    });
    const plan = await host.buildPlan(action);
    await host.execute(plan);

    const result = await host.rollback(plan.id);
    expect(result.success).toBe(false);
    expect(result.message).toBe('no rollback available');
  });

  it('rollback fails when plan is not in completed status', async () => {
    const result = await host.rollback('plan-that-was-never-executed');
    expect(result.success).toBe(false);
    expect(result.message).toContain('No execution log');
  });

  // ── circuit breaker ──────────────────────────────────────────────────────

  it('circuit breaker opens after 3 consecutive failures and rejects further calls', async () => {
    const alwaysFailClient = makeFakeClient({ callToolResult: new Error('network error') });
    const cfg: McpServerConfig = { id: 'cb-server', transport: 'stdio', command: 'node' };
    injectFakeServer(host, cfg, alwaysFailClient);

    const makeFailAction = (): CandidateAction =>
      makeAction({
        parameters: { mcpServerId: 'cb-server', mcpToolName: 'send_email' },
      });

    // Three failures open the circuit (failureThreshold = 3)
    for (let i = 0; i < 3; i++) {
      const plan = await host.buildPlan(makeFailAction());
      const r = await host.execute(plan);
      expect(r.status).toBe('failed');
    }

    // 4th call: circuit is open → immediate fail with CircuitOpenError message
    const plan4 = await host.buildPlan(makeFailAction());
    const result4 = await host.execute(plan4);
    expect(result4.status).toBe('failed');
    expect(result4.error).toMatch(/[Cc]ircuit/);
  });

  // ── healthCheck ──────────────────────────────────────────────────────────

  it('healthCheck returns healthy:true for an empty host', async () => {
    const emptyHost = new McpHost();
    const result = await emptyHost.healthCheck();
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBe(0);
  });

  it('healthCheck pings running servers and returns aggregate result', async () => {
    const result = await host.healthCheck();
    expect(typeof result.healthy).toBe('boolean');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('healthCheck falls back to listTools when ping fails', async () => {
    const pingFailClient = makeFakeClient({ pingError: true });
    const cfg: McpServerConfig = { id: 'ping-fail-server', transport: 'stdio', command: 'node' };
    injectFakeServer(host, cfg, pingFailClient);

    const result = await host.healthCheck();
    expect(typeof result.healthy).toBe('boolean');
  });

  // ── listSkills ───────────────────────────────────────────────────────────

  it('listSkills returns tools from the MCP server', async () => {
    const result = await host.listSkills('test-server');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skills.length).toBeGreaterThan(0);
      const emailSkill = result.skills.find((s) => s.name === 'send_email');
      expect(emailSkill).toBeDefined();
    }
  });

  it('listSkills returns error result for unknown server', async () => {
    const result = await host.listSkills('nonexistent');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not installed');
    }
  });

  // ── integration tests (skipped — wired in follow-up) ────────────────────

  it.skip('TODO #173 AC#3: integration against real @modelcontextprotocol/server-filesystem', async () => {
    // Requires: npx @modelcontextprotocol/server-filesystem available in PATH
    // and a real temp directory to operate on.
  });

  it.skip('TODO #173 AC#3: integration against a real HTTP MCP server', async () => {
    // Requires a local test HTTP MCP server on a known port.
  });

  it.skip('TODO #173 AC#3: full buildPlan → execute → rollback lifecycle integration', async () => {
    // End-to-end lifecycle test against a real server.
  });
});
