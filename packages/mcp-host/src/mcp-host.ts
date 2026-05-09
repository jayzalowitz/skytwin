import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import type {
  CandidateAction,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStatus,
  ExecutionStep,
  RollbackResult,
} from '@skytwin/shared-types';
import { CircuitBreaker, CircuitOpenError, withRetry } from '@skytwin/core';
import { createStdioTransport } from './stdio-runner.js';
import { isDockerAvailable, spawnInDockerNoNetworkAsync } from './docker-spawn.js';
import { DockerStdioTransport } from './docker-stdio-transport.js';
import type {
  McpExecutionLog,
  McpServerConfig,
  McpServerHandle,
  McpSkill,
} from './types.js';

interface ServerEntry {
  config: McpServerConfig;
  handle: McpServerHandle;
  client: Client;
  circuit: CircuitBreaker;
  stop: () => void | Promise<void>;
}

const MAX_TRACKED_EXECUTIONS = 1000;

const ROLLBACK_HEURISTICS: Array<(name: string) => string> = [
  (name) => `${name}_undo`,
  (name) => `undo_${name}`,
  (name) => {
    if (name.startsWith('send')) return `unsend${name.slice(4)}`;
    if (name.startsWith('create')) return `delete${name.slice(6)}`;
    if (name.startsWith('post')) return `delete${name.slice(4)}`;
    if (name.startsWith('publish')) return `unpublish${name.slice(7)}`;
    return '';
  },
];

/**
 * McpHost implements IronClawAdapter so it can be registered alongside
 * IronClaw, OpenClaw, and Direct adapters in the execution-router.
 *
 * It manages a set of MCP servers (stdio, http, sse), routes CandidateActions
 * to the appropriate server via `buildPlan`, and executes them through the
 * MCP SDK's `call_tool` RPC. Each server is protected by a CircuitBreaker
 * (3 failures in 60 s → mark failed, no auto-restart).
 */
/**
 * Hook fired after each tool call (success or failure). Used by the
 * observability layer (#183) to record per-server telemetry; pass the
 * recorder bound to a shared MetricsCollector. Failures inside the hook
 * are swallowed so observability never blocks execution.
 */
export interface McpHostToolCallEvent {
  serverId: string;
  toolName: string;
  latencyMs: number;
  success: boolean;
  /**
   * Cost of the tool call in cents, when the adapter can attribute it
   * (e.g. an LLM-backed MCP server reporting token usage). Undefined when
   * the call is free or the cost is unknown — do NOT report 0, since 0
   * is a valid cost value and the rollup sums it.
   */
  spendCents?: number;
  ts: Date;
}

/**
 * Hook fired after a changelog fetch (at install time, on list_tools refresh,
 * or weekly sweep). rawText is null when the server has no changelog:// resource.
 * Failures inside the hook are swallowed so changelog fetches never block install.
 */
export interface McpHostChangelogFetchEvent {
  serverId: string;
  rawText: string | null;
  currentVersion?: string;
}

export interface McpHostOptions {
  onToolCall?: (event: McpHostToolCallEvent) => void;
  /** Optional hook fired after each changelog fetch. Errors are swallowed. */
  onChangelogFetch?: (event: McpHostChangelogFetchEvent) => void;
  /**
   * Hard-rail hook (#184 AC#2): called before executing a tool to check
   * whether the user has an unaccepted pending opt-in for this skill.
   *
   * If this returns true, the execution is blocked with a 'failed' result
   * and an explanatory error message. Callers should inject this from the
   * DB layer (mcpServerChangelogRepository.hasPendingOptIn). Omit in tests
   * or contexts where the DB is not available.
   *
   * This is an async callback so the DB round-trip stays outside mcp-host.
   */
  checkPendingOptIn?: (serverId: string, skillName: string) => Promise<boolean>;
}

// ─── Destructive skill heuristic ─────────────────────────────────────────────
// A skill is considered destructive if its name contains any of the following
// verb prefixes. This is a conservative over-approximation — false positives
// are safer than false negatives for opt-in gate purposes.
const DESTRUCTIVE_PREFIXES = [
  'create', 'delete', 'update', 'write', 'send', 'post',
  'commit', 'push', 'merge', 'mutate', 'set', 'remove',
] as const;

/**
 * Returns true if the skill name matches the destructive-skill heuristic.
 *
 * The check is case-insensitive and matches anywhere in the skill name so
 * that compound names like `batch_create_issues` or `filesystem_write` are
 * correctly flagged.
 */
export function isDestructiveSkill(skillName: string): boolean {
  const lower = skillName.toLowerCase();
  return DESTRUCTIVE_PREFIXES.some((prefix) => lower.includes(prefix));
}

// ─── Version-heading extraction ───────────────────────────────────────────────
// Looks for `## v1.2.3` or `# 1.2.3` style headings in the changelog text.
const VERSION_HEADING_RE = /^#{1,3}\s+v?([\d]+\.[\d]+(?:\.[\d]+)?(?:-[a-zA-Z0-9.]+)?)\b/m;

function extractVersionFromChangelog(text: string): string | undefined {
  const match = VERSION_HEADING_RE.exec(text);
  return match?.[1] ?? undefined;
}

export class McpHost implements IronClawAdapter {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly executions = new Map<string, McpExecutionLog>();
  private readonly onToolCall: ((event: McpHostToolCallEvent) => void) | undefined;
  private readonly onChangelogFetch: ((event: McpHostChangelogFetchEvent) => void) | undefined;
  private readonly checkPendingOptIn: ((serverId: string, skillName: string) => Promise<boolean>) | undefined;

  constructor(options: McpHostOptions = {}) {
    this.onToolCall = options.onToolCall;
    this.onChangelogFetch = options.onChangelogFetch;
    this.checkPendingOptIn = options.checkPendingOptIn;
  }

  private emitToolCall(event: McpHostToolCallEvent): void {
    if (!this.onToolCall) return;
    try {
      this.onToolCall(event);
    } catch {
      // observability hook must never block execution
    }
  }

  private emitChangelogFetch(event: McpHostChangelogFetchEvent): void {
    if (!this.onChangelogFetch) return;
    try {
      this.onChangelogFetch(event);
    } catch {
      // changelog hook must never block execution
    }
  }

  private evictOldExecutions(): void {
    if (this.executions.size <= MAX_TRACKED_EXECUTIONS) return;
    const excess = this.executions.size - MAX_TRACKED_EXECUTIONS;
    let removed = 0;
    for (const key of this.executions.keys()) {
      if (removed >= excess) break;
      this.executions.delete(key);
      removed++;
    }
  }

  async installServer(config: McpServerConfig): Promise<{ success: boolean; error?: string }> {
    if (this.servers.has(config.id)) {
      return { success: false, error: `Server '${config.id}' is already installed.` };
    }

    const handle: McpServerHandle = {
      id: config.id,
      status: 'starting',
    };

    const circuit = new CircuitBreaker(`mcp:${config.id}`, {
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
    });

    const client = new Client(
      { name: `skytwin-mcp-host/${config.id}`, version: '0.1.0' },
      { capabilities: {} },
    );

    try {
      let stop: () => void | Promise<void>;

      if (config.transport === 'stdio') {
        // Zero-trust mode: wrap spawn in docker --network=none when requested.
        // Only applies to stdio transport. HTTP/SSE servers are remote — network
        // isolation would sever the connection entirely.
        if (config.zeroTrustMode === true) {
          if (!config.command) {
            return { success: false, error: `Zero-trust stdio server '${config.id}' requires a command.` };
          }

          const dockerAvailable = await isDockerAvailable();
          if (!dockerAvailable) {
            // Graceful fallback: log warning, mark failedToIsolate, continue with regular spawn.
            process.stderr.write(
              `[mcp-host] WARNING: zero-trust mode requested for '${config.id}' but Docker is not available. ` +
              `Starting without container isolation. Set failedToIsolate=true.\n`,
            );
            handle.failedToIsolate = true;

            const { transport } = createStdioTransport(config);
            transport.onclose = () => {
              const entry = this.servers.get(config.id);
              if (entry && entry.handle.status === 'running') {
                entry.handle.status = 'failed';
                entry.handle.lastError = 'Transport closed unexpectedly';
                circuit.recordFailure();
              }
            };
            await client.connect(transport);
            stop = () => client.close();
          } else {
            const dockerResult = await spawnInDockerNoNetworkAsync({
              command: config.command,
              args: config.args ?? [],
              env: config.env,
              mountGlobalNodeModules: true,
              memoryMb: config.resourceLimits?.memoryMb,
            });

            const transport = new DockerStdioTransport(dockerResult);
            transport.onclose = () => {
              const entry = this.servers.get(config.id);
              if (entry && entry.handle.status === 'running') {
                entry.handle.status = 'failed';
                entry.handle.lastError = 'Docker transport closed unexpectedly';
                circuit.recordFailure();
              }
            };
            await client.connect(transport);
            stop = () => client.close();
          }
        } else {
          const { transport } = createStdioTransport(config);

          transport.onclose = () => {
            const entry = this.servers.get(config.id);
            if (entry && entry.handle.status === 'running') {
              entry.handle.status = 'failed';
              entry.handle.lastError = 'Transport closed unexpectedly';
              circuit.recordFailure();
            }
          };

          await client.connect(transport);
          stop = () => client.close();
        }
      } else if (config.transport === 'sse') {
        if (!config.url) {
          return { success: false, error: `SSE transport requires 'url'.` };
        }
        const transport = new SSEClientTransport(new URL(config.url));
        await client.connect(transport);
        stop = () => client.close();
      } else {
        if (!config.url) {
          return { success: false, error: `HTTP transport requires 'url'.` };
        }
        const transport = new StreamableHTTPClientTransport(new URL(config.url));
        await client.connect(transport);
        stop = () => client.close();
      }

      handle.status = 'running';
      handle.startedAt = new Date();

      this.servers.set(config.id, { config, handle, client, circuit, stop });

      // Best-effort changelog fetch at install time (#184 AC#2).
      // Errors are swallowed — a failing changelog fetch must never block install.
      this.fetchChangelog(config.id).then((changelog) => {
        this.emitChangelogFetch({
          serverId: config.id,
          rawText: changelog?.rawText ?? null,
          currentVersion: changelog?.currentVersion,
        });
      }).catch(() => {
        // Swallow — best effort
      });

      return { success: true };
    } catch (err) {
      handle.status = 'failed';
      handle.lastError = err instanceof Error ? err.message : String(err);
      return { success: false, error: handle.lastError };
    }
  }

  async uninstallServer(id: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.servers.get(id);
    if (!entry) {
      return { success: false, error: `Server '${id}' is not installed.` };
    }

    try {
      await entry.stop();
    } catch {
      // best-effort stop
    }

    entry.handle.status = 'stopped';
    this.servers.delete(id);
    return { success: true };
  }

  listServers(): McpServerHandle[] {
    return Array.from(this.servers.values()).map((e) => ({ ...e.handle }));
  }

  async listSkills(
    serverId: string,
  ): Promise<{ success: true; skills: McpSkill[] } | { success: false; error: string }> {
    const entry = this.servers.get(serverId);
    if (!entry) {
      return { success: false, error: `Server '${serverId}' is not installed.` };
    }

    try {
      const result = await withCircuitBreakerGuard(entry.circuit, () =>
        entry.client.listTools(),
      );

      const skills: McpSkill[] = (result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        isDestructive: false,
        isIrreversible: false,
      }));

      return { success: true, skills };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Fetch the upstream server's changelog via the `changelog://` MCP resource
   * convention (issue #184 AC#2).
   *
   * 1. Calls client.listResources() to discover resources.
   * 2. If a resource with URI starting with `changelog://` is found, reads it.
   * 3. Extracts a heuristic version from the first `## vX.Y.Z` or `# X.Y.Z` heading.
   * 4. Returns null (best-effort) if:
   *    - The server is not installed.
   *    - listResources is not supported (throws).
   *    - No changelog:// resource is present.
   *
   * Rate-limit enforcement (12h cadence) is the caller's responsibility —
   * this method always attempts the fetch when called.
   */
  async fetchChangelog(serverId: string): Promise<{ currentVersion?: string; rawText?: string } | null> {
    const entry = this.servers.get(serverId);
    if (!entry) return null;

    let resources: Array<{ uri: string }>;
    try {
      const listResult = await entry.client.listResources();
      resources = (listResult.resources ?? []) as Array<{ uri: string }>;
    } catch {
      // listResources not supported by this server — best effort, return null
      return null;
    }

    const changelogResource = resources.find((r) => r.uri?.startsWith('changelog://'));
    if (!changelogResource) return null;

    try {
      const readResult = await entry.client.readResource({ uri: changelogResource.uri });
      // readResource returns { contents: Array<{ type, text? }> }
      const contents = (readResult as { contents?: Array<{ type?: string; text?: string }> }).contents ?? [];
      const textContent = contents.find((c) => c.type === 'text' || typeof c.text === 'string');
      const rawText = textContent?.text ?? '';
      if (!rawText) return null;

      const currentVersion = extractVersionFromChangelog(rawText);
      return { currentVersion, rawText };
    } catch {
      return null;
    }
  }

  async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
    const planId =
      (action.parameters['executionPlanId'] as string | undefined) ??
      `mcp_plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const serverId =
      (action.parameters['mcpServerId'] as string | undefined) ??
      this.selectServerForAction(action);

    const toolName =
      (action.parameters['mcpToolName'] as string | undefined) ?? action.actionType;

    const now = new Date();

    const step: ExecutionStep = {
      id: `step_${planId}_1`,
      order: 1,
      type: action.actionType,
      description: action.description,
      parameters: {
        ...action.parameters,
        _mcpServerId: serverId,
        _mcpToolName: toolName,
      },
      timeout: 30_000,
    };

    const rollbackSteps: ExecutionStep[] = action.reversible
      ? [
          {
            id: `step_${planId}_rollback_1`,
            order: 1,
            type: `rollback_${action.actionType}`,
            description: `Rollback: ${action.description}`,
            parameters: {
              ...action.parameters,
              _mcpServerId: serverId,
              _mcpToolName: toolName,
              _isRollback: true,
              originalActionType: action.actionType,
            },
            timeout: 30_000,
          },
        ]
      : [];

    return {
      id: planId,
      decisionId: action.decisionId,
      action,
      steps: [step],
      rollbackSteps,
      createdAt: now,
    };
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    const startedAt = new Date();
    this.evictOldExecutions();

    const log: McpExecutionLog = {
      planId: plan.id,
      serverId: '',
      toolName: '',
      startedAt,
      status: 'running',
    };
    this.executions.set(plan.id, log);

    const step = plan.steps[0];
    if (!step) {
      log.status = 'failed';
      log.error = 'No execution steps in plan';
      return errorResult(plan.id, startedAt, log.error);
    }

    const serverId = step.parameters['_mcpServerId'] as string | undefined;
    const toolName = step.parameters['_mcpToolName'] as string | undefined;

    if (!serverId || !toolName) {
      log.status = 'failed';
      log.error = 'Plan step missing _mcpServerId or _mcpToolName — was buildPlan called?';
      return errorResult(plan.id, startedAt, log.error);
    }

    log.serverId = serverId;
    log.toolName = toolName;

    // Hard rail (#184 AC#2): block execution if the user has not yet opted in
    // to this destructive skill. The checkPendingOptIn callback is injected
    // from the API layer to avoid a DB dependency in mcp-host.
    if (this.checkPendingOptIn && isDestructiveSkill(toolName)) {
      let blocked = false;
      try {
        blocked = await this.checkPendingOptIn(serverId, toolName);
      } catch {
        // If the opt-in check itself fails, fail safe: block execution.
        blocked = true;
      }
      if (blocked) {
        log.status = 'failed';
        log.error = `Skill '${toolName}' requires explicit opt-in before it can be executed. Accept the pending opt-in prompt in the Capabilities dashboard.`;
        return errorResult(plan.id, startedAt, log.error);
      }
    }

    const entry = this.servers.get(serverId);
    if (!entry) {
      log.status = 'failed';
      log.error = `MCP server '${serverId}' is not installed`;
      return errorResult(plan.id, startedAt, log.error);
    }

    const toolArgs = buildToolArgs(step.parameters);

    try {
      const callResult = await withRetry(
        () =>
          withCircuitBreakerGuard(entry.circuit, () =>
            entry.client.callTool({ name: toolName, arguments: toolArgs }),
          ),
        { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000 },
      );

      const completedAt = new Date();
      log.status = 'completed';
      log.completedAt = completedAt;
      log.output = extractOutput(callResult);

      // spendCents intentionally omitted — MCP tool calls have no
      // cost attribution today. Reporting 0 would have polluted
      // sum-aggregations with N spurious zero entries; omitting lets
      // the rollup treat unknown-cost calls correctly.
      this.emitToolCall({
        serverId,
        toolName,
        latencyMs: completedAt.getTime() - startedAt.getTime(),
        success: true,
        ts: completedAt,
      });

      return {
        planId: plan.id,
        status: 'completed',
        startedAt,
        completedAt,
        output: log.output,
      };
    } catch (err) {
      const completedAt = new Date();
      const error = err instanceof Error ? err.message : String(err);
      log.status = 'failed';
      log.completedAt = completedAt;
      log.error = error;

      if (err instanceof CircuitOpenError) {
        entry.handle.status = 'failed';
        entry.handle.lastError = error;
      }

      this.emitToolCall({
        serverId,
        toolName,
        latencyMs: completedAt.getTime() - startedAt.getTime(),
        success: false,
        ts: completedAt,
      });

      return { planId: plan.id, status: 'failed', startedAt, completedAt, error };
    }
  }

  async getStatus(planId: string): Promise<ExecutionStatus> {
    const log = this.executions.get(planId);
    if (!log) {
      throw new Error(`No execution found for plan ID: ${planId}`);
    }
    return log.status;
  }

  async rollback(planId: string): Promise<RollbackResult> {
    const log = this.executions.get(planId);
    if (!log) {
      return { success: false, message: `No execution log for plan ID: ${planId}` };
    }

    if (log.status !== 'completed') {
      return {
        success: false,
        message: `Cannot rollback plan in '${log.status}' status. Must be 'completed'.`,
      };
    }

    const entry = this.servers.get(log.serverId);
    if (!entry) {
      return { success: false, message: `MCP server '${log.serverId}' is no longer available` };
    }

    const undoToolName = await this.findUndoTool(entry, log.toolName);
    if (!undoToolName) {
      return { success: false, message: 'no rollback available' };
    }

    try {
      await withCircuitBreakerGuard(entry.circuit, () =>
        entry.client.callTool({
          name: undoToolName,
          arguments: { originalPlanId: planId, ...log.output },
        }),
      );

      return { success: true, message: `Rolled back via '${undoToolName}'` };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    if (this.servers.size === 0) {
      return { healthy: true, latencyMs: 0 };
    }

    const results = await Promise.all(
      Array.from(this.servers.values()).map((entry) => pingServer(entry)),
    );

    const allHealthy = results.every((r) => r.healthy);
    const maxLatency = results.reduce((max, r) => Math.max(max, r.latencyMs), 0);

    return { healthy: allHealthy, latencyMs: maxLatency };
  }

  private selectServerForAction(_action: CandidateAction): string {
    for (const [id, entry] of this.servers) {
      if (entry.handle.status === 'running') {
        return id;
      }
    }
    return '';
  }

  private async findUndoTool(entry: ServerEntry, toolName: string): Promise<string | null> {
    let availableTools: string[] = [];
    try {
      const result = await entry.client.listTools();
      availableTools = (result.tools ?? []).map((t) => t.name);
    } catch {
      return null;
    }

    for (const heuristic of ROLLBACK_HEURISTICS) {
      const candidate = heuristic(toolName);
      if (candidate && availableTools.includes(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}

async function withCircuitBreakerGuard<T>(
  breaker: CircuitBreaker,
  fn: () => Promise<T>,
): Promise<T> {
  if (!breaker.canExecute()) {
    throw new CircuitOpenError(breaker.name, breaker.getTimeUntilRetryMs());
  }
  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (err) {
    breaker.recordFailure();
    throw err;
  }
}

async function pingServer(entry: ServerEntry): Promise<{ healthy: boolean; latencyMs: number }> {
  const start = Date.now();
  const timeoutMs = 2_000;

  const withTimeout = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs),
      ),
    ]);

  try {
    await withTimeout(entry.client.ping());
    return { healthy: true, latencyMs: Date.now() - start };
  } catch {
    // Ping not supported — fall back to list_tools
    try {
      await withTimeout(entry.client.listTools());
      return { healthy: true, latencyMs: Date.now() - start };
    } catch {
      entry.handle.status = 'failed';
      entry.handle.lastError = 'health check failed';
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }
}

function buildToolArgs(parameters: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (key.startsWith('_mcp') || key === 'executionPlanId') continue;
    args[key] = value;
  }
  return args;
}

function extractOutput(callResult: unknown): Record<string, unknown> {
  if (callResult === null || callResult === undefined) return {};
  if (typeof callResult !== 'object') return { result: callResult };
  return callResult as Record<string, unknown>;
}

function errorResult(planId: string, startedAt: Date, error: string): ExecutionResult {
  return { planId, status: 'failed', startedAt, completedAt: new Date(), error };
}
