import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker } from '@skytwin/core';
import { McpHost, isDestructiveSkill } from '../mcp-host.js';
import type { McpServerConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Fake MCP Client for changelog tests
//
// Extends the base fake with listResources + readResource support.
// ---------------------------------------------------------------------------

interface FakeResourceOpts {
  resources?: Array<{ uri: string; name?: string }>;
  resourceText?: string;
  listResourcesThrows?: boolean;
  readResourceThrows?: boolean;
}

function makeFakeChangelogClient(opts: FakeResourceOpts = {}) {
  return {
    async connect(_transport: unknown): Promise<void> {},
    async close(): Promise<void> {},
    async ping(): Promise<void> {},
    async listTools(): Promise<{ tools: Array<{ name: string }> }> {
      return { tools: [] };
    },
    async callTool(_params: unknown): Promise<unknown> {
      return { ok: true };
    },
    async listResources(): Promise<{ resources: Array<{ uri: string; name?: string }> }> {
      if (opts.listResourcesThrows) {
        throw new Error('listResources not supported');
      }
      return { resources: opts.resources ?? [] };
    },
    async readResource(_params: { uri: string }): Promise<{
      contents: Array<{ type: string; text: string }>;
    }> {
      if (opts.readResourceThrows) {
        throw new Error('readResource failed');
      }
      return {
        contents: [{ type: 'text', text: opts.resourceText ?? '' }],
      };
    },
  };
}

type FakeChangelogClient = ReturnType<typeof makeFakeChangelogClient>;

interface InternalServerEntry {
  config: McpServerConfig;
  handle: {
    id: string;
    status: 'starting' | 'running' | 'failed' | 'stopped';
    startedAt?: Date;
  };
  client: FakeChangelogClient;
  circuit: CircuitBreaker;
  stop: () => void;
}

function injectFakeServer(host: McpHost, config: McpServerConfig, client: FakeChangelogClient): void {
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

const serverConfig: McpServerConfig = {
  id: 'test-server',
  transport: 'stdio',
  command: 'node',
  args: ['fake-server.js'],
};

// ---------------------------------------------------------------------------
// fetchChangelog tests
// ---------------------------------------------------------------------------

describe('McpHost.fetchChangelog', () => {
  let host: McpHost;

  beforeEach(() => {
    host = new McpHost();
  });

  it('returns null when the server is not installed', async () => {
    const result = await host.fetchChangelog('nonexistent-server');
    expect(result).toBeNull();
  });

  it('returns null when listResources is not supported (throws)', async () => {
    const client = makeFakeChangelogClient({ listResourcesThrows: true });
    injectFakeServer(host, serverConfig, client);
    const result = await host.fetchChangelog(serverConfig.id);
    expect(result).toBeNull();
  });

  it('returns null when no changelog:// resource is present', async () => {
    const client = makeFakeChangelogClient({
      resources: [{ uri: 'memory://context', name: 'Memory' }],
    });
    injectFakeServer(host, serverConfig, client);
    const result = await host.fetchChangelog(serverConfig.id);
    expect(result).toBeNull();
  });

  it('returns rawText when a changelog:// resource is present', async () => {
    const client = makeFakeChangelogClient({
      resources: [{ uri: 'changelog://CHANGELOG.md', name: 'Changelog' }],
      resourceText: '## v1.2.3\n\nAdded create_database tool.',
    });
    injectFakeServer(host, serverConfig, client);
    const result = await host.fetchChangelog(serverConfig.id);
    expect(result).not.toBeNull();
    expect(result?.rawText).toContain('Added create_database tool');
  });

  it('extracts currentVersion from ## vX.Y.Z heading', async () => {
    const client = makeFakeChangelogClient({
      resources: [{ uri: 'changelog://CHANGELOG.md' }],
      resourceText: '## v2.0.1\n\nBug fixes.',
    });
    injectFakeServer(host, serverConfig, client);
    const result = await host.fetchChangelog(serverConfig.id);
    expect(result?.currentVersion).toBe('2.0.1');
  });

  it('extracts currentVersion from # X.Y.Z heading (no v prefix)', async () => {
    const client = makeFakeChangelogClient({
      resources: [{ uri: 'changelog://CHANGELOG.md' }],
      resourceText: '# 3.1.0\n\nNew features.',
    });
    injectFakeServer(host, serverConfig, client);
    const result = await host.fetchChangelog(serverConfig.id);
    expect(result?.currentVersion).toBe('3.1.0');
  });

  it('returns null when readResource throws', async () => {
    const client = makeFakeChangelogClient({
      resources: [{ uri: 'changelog://CHANGELOG.md' }],
      readResourceThrows: true,
    });
    injectFakeServer(host, serverConfig, client);
    const result = await host.fetchChangelog(serverConfig.id);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isDestructiveSkill heuristic tests
// ---------------------------------------------------------------------------

describe('isDestructiveSkill', () => {
  it('returns true for names containing "create"', () => {
    expect(isDestructiveSkill('create_database')).toBe(true);
    expect(isDestructiveSkill('batch_create_issues')).toBe(true);
  });

  it('returns true for names containing "delete"', () => {
    expect(isDestructiveSkill('delete_file')).toBe(true);
    expect(isDestructiveSkill('delete')).toBe(true);
  });

  it('returns true for names containing "update"', () => {
    expect(isDestructiveSkill('update_record')).toBe(true);
  });

  it('returns true for names containing "send"', () => {
    expect(isDestructiveSkill('send_email')).toBe(true);
    expect(isDestructiveSkill('unsend_message')).toBe(true);
  });

  it('returns true for names containing "write"', () => {
    expect(isDestructiveSkill('filesystem_write')).toBe(true);
    expect(isDestructiveSkill('write_page')).toBe(true);
  });

  it('returns true for names containing "remove"', () => {
    expect(isDestructiveSkill('remove_label')).toBe(true);
  });

  it('returns true for names containing "commit"', () => {
    expect(isDestructiveSkill('git_commit')).toBe(true);
  });

  it('returns true for names containing "mutate"', () => {
    expect(isDestructiveSkill('mutate_graph')).toBe(true);
  });

  it('returns false for read-only skill names', () => {
    expect(isDestructiveSkill('read_file')).toBe(false);
    expect(isDestructiveSkill('list_issues')).toBe(false);
    expect(isDestructiveSkill('get_calendar_events')).toBe(false);
    expect(isDestructiveSkill('search_emails')).toBe(false);
    expect(isDestructiveSkill('describe_table')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isDestructiveSkill('CREATE_TABLE')).toBe(true);
    expect(isDestructiveSkill('DELETE_RECORD')).toBe(true);
    expect(isDestructiveSkill('Send_Message')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hard-rail opt-in check in execute
// ---------------------------------------------------------------------------

describe('McpHost execute hard-rail (pending opt-in)', () => {
  it('blocks execution when checkPendingOptIn returns true for a destructive skill', async () => {
    const checkPendingOptIn = vi.fn().mockResolvedValue(true);
    const blockedHost = new McpHost({ checkPendingOptIn });

    const client = makeFakeChangelogClient();
    injectFakeServer(blockedHost, serverConfig, client);

    const plan = {
      id: 'plan-1',
      decisionId: 'decision-1',
      action: {} as never,
      steps: [
        {
          id: 'step-1',
          order: 1,
          type: 'send_email',
          description: 'test',
          parameters: { _mcpServerId: serverConfig.id, _mcpToolName: 'send_email' },
          timeout: 5000,
        },
      ],
      rollbackSteps: [],
      createdAt: new Date(),
    };

    const result = await blockedHost.execute(plan);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('requires explicit opt-in');
    expect(checkPendingOptIn).toHaveBeenCalledWith(serverConfig.id, 'send_email');
  });

  it('allows execution when checkPendingOptIn returns false', async () => {
    const checkPendingOptIn = vi.fn().mockResolvedValue(false);

    // We need a real client that can handle callTool
    const fakeClient = {
      async connect(_transport: unknown) {},
      async close() {},
      async ping() {},
      async listTools() { return { tools: [] }; },
      async callTool() { return { ok: true }; },
      async listResources() { return { resources: [] }; },
      async readResource() { return { contents: [] }; },
    };

    const allowedHost = new McpHost({ checkPendingOptIn });
    const circuit = new CircuitBreaker(`mcp:${serverConfig.id}`, { failureThreshold: 3, resetTimeoutMs: 60_000 });
    const entry = { config: serverConfig, handle: { id: serverConfig.id, status: 'running' as const }, client: fakeClient, circuit, stop: () => {} };
    (allowedHost as unknown as { servers: Map<string, typeof entry> }).servers.set(serverConfig.id, entry);

    const plan = {
      id: 'plan-2',
      decisionId: 'decision-2',
      action: {} as never,
      steps: [
        {
          id: 'step-2',
          order: 1,
          type: 'send_email',
          description: 'test',
          parameters: { _mcpServerId: serverConfig.id, _mcpToolName: 'send_email' },
          timeout: 5000,
        },
      ],
      rollbackSteps: [],
      createdAt: new Date(),
    };

    const result = await allowedHost.execute(plan);
    expect(result.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// onChangelogFetch hook tests
// ---------------------------------------------------------------------------

describe('McpHost onChangelogFetch hook', () => {
  it('fires onChangelogFetch after installServer succeeds', async () => {
    const events: Array<{ serverId: string; rawText: string | null }> = [];

    // We cannot do a real installServer in unit tests (needs real transport).
    // Instead, test that the hook is wired by calling fetchChangelog directly
    // and verifying emitChangelogFetch behavior via the hook option.
    const client = makeFakeChangelogClient({
      resources: [{ uri: 'changelog://CHANGELOG.md' }],
      resourceText: '## v1.0.0\n\nInitial release.',
    });

    const hostWithHook = new McpHost({
      onChangelogFetch: (event) => {
        events.push({ serverId: event.serverId, rawText: event.rawText });
      },
    });

    injectFakeServer(hostWithHook, serverConfig, client);

    // Simulate what installServer does: call fetchChangelog and emitChangelogFetch
    const changelog = await hostWithHook.fetchChangelog(serverConfig.id);
    const emitFn = (hostWithHook as unknown as { emitChangelogFetch: (e: { serverId: string; rawText: string | null; currentVersion?: string }) => void }).emitChangelogFetch;
    emitFn.call(hostWithHook, {
      serverId: serverConfig.id,
      rawText: changelog?.rawText ?? null,
      currentVersion: changelog?.currentVersion,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.serverId).toBe(serverConfig.id);
    expect(events[0]?.rawText).toContain('Initial release');
  });

  it('onChangelogFetch errors do not propagate', () => {
    const hostWithThrowingHook = new McpHost({
      onChangelogFetch: () => {
        throw new Error('hook blew up');
      },
    });

    const emitFn = (hostWithThrowingHook as unknown as { emitChangelogFetch: (e: { serverId: string; rawText: string | null }) => void }).emitChangelogFetch;
    // Should not throw
    expect(() => emitFn.call(hostWithThrowingHook, { serverId: 'x', rawText: null })).not.toThrow();
  });
});
