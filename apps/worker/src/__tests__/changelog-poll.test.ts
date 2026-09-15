import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the job
// ---------------------------------------------------------------------------

const {
  mockChangelogRepo,
  mockServerRepo,
} = vi.hoisted(() => ({
  mockChangelogRepo: {
    getForServer: vi.fn(),
    upsert: vi.fn(),
    addPendingOptIn: vi.fn(),
    listPendingOptInsForUser: vi.fn(),
    acceptOptIn: vi.fn(),
    rejectOptIn: vi.fn(),
    hasPendingOptIn: vi.fn(),
  },
  mockServerRepo: {
    listActive: vi.fn(),
    listSkillNamesForServer: vi.fn(),
    getById: vi.fn(),
    markDormant: vi.fn(),
    markActive: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  mcpServerChangelogRepository: mockChangelogRepo,
  mcpServerRepository: mockServerRepo,
}));

// ---------------------------------------------------------------------------
// Import job under test AFTER mocks are wired
// ---------------------------------------------------------------------------

import { runChangelogPollJob } from '../jobs/changelog-poll.js';
import { McpHost, isDestructiveSkill } from '@skytwin/mcp-host';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeServer(overrides: {
  id?: string;
  display_name?: string;
  user_id?: string;
  status?: string;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string | null;
  args?: unknown;
  env?: unknown;
  url?: string | null;
  registry_id?: string | null;
  oauth_provider?: string | null;
} = {}) {
  return {
    id: overrides.id ?? 'server-1',
    display_name: overrides.display_name ?? 'Test Server',
    user_id: overrides.user_id ?? 'user-1',
    status: overrides.status ?? 'active',
    transport: overrides.transport ?? ('stdio' as const),
    command: overrides.command ?? null,
    args: overrides.args ?? null,
    env: overrides.env ?? null,
    url: overrides.url ?? null,
    registry_id: overrides.registry_id ?? null,
    trust_tier: 'observer' as const,
    per_app_spend_per_action_cents: null,
    per_app_daily_spend_cents: null,
    per_app_monthly_spend_cents: null,
    per_app_monthly_rollover: false,
    per_app_irreversible_requires_approval: null,
    zero_trust_mode: false,
    last_health_check_at: null,
    health_status: null,
    last_active_at: null,
    installed_at: null,
    uninstalled_at: null,
    auto_promote_paused_until: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    oauth_provider: overrides.oauth_provider ?? null,
    oauth_token_id: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockChangelogRepo.upsert.mockResolvedValue(undefined);
  mockChangelogRepo.addPendingOptIn.mockResolvedValue(undefined);
  mockServerRepo.listSkillNamesForServer.mockResolvedValue([]);
});

describe('runChangelogPollJob', () => {
  it('never starts stale Google servers while disabled and still polls a neighbor', async () => {
    const googleServer = makeServer({
      id: 'google-server',
      display_name: 'Account server',
      registry_id: 'gmail-mcp',
      oauth_provider: 'google',
    });
    const neighboringServer = makeServer({
      id: 'github-server',
      display_name: 'GitHub',
      registry_id: '@modelcontextprotocol/server-github',
    });
    mockServerRepo.listActive.mockResolvedValue([googleServer, neighboringServer]);
    mockChangelogRepo.getForServer.mockResolvedValue(null);
    const neighborHost = {
      installServer: vi.fn().mockResolvedValue({ success: true }),
      fetchChangelog: vi.fn().mockResolvedValue(null),
      listSkills: vi.fn().mockResolvedValue({ success: true, skills: [] }),
      uninstallServer: vi.fn().mockResolvedValue({ success: true }),
    };
    const factory = vi.fn(() => neighborHost as unknown as McpHost);

    await runChangelogPollJob({
      changelogRepo: mockChangelogRepo,
      serverRepo: mockServerRepo as unknown as typeof import('@skytwin/db').mcpServerRepository,
      mcpHostFactory: factory,
      googleConnectionMode: 'disabled',
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ id: 'github-server' }));
    expect(neighborHost.installServer).toHaveBeenCalledOnce();
    expect(neighborHost.fetchChangelog).toHaveBeenCalledWith('github-server');
    expect(neighborHost.listSkills).toHaveBeenCalledWith('github-server');
    expect(mockChangelogRepo.getForServer).not.toHaveBeenCalledWith('google-server');
  });

  it('skips a generic stale server whose cached skills are account-backed', async () => {
    const server = makeServer({ id: 'custom-mail', registry_id: 'custom-tools' });
    mockServerRepo.listActive.mockResolvedValue([server]);
    mockServerRepo.listSkillNamesForServer.mockResolvedValue(['read_email']);
    const factory = vi.fn();

    await runChangelogPollJob({
      changelogRepo: mockChangelogRepo,
      serverRepo: mockServerRepo as unknown as typeof import('@skytwin/db').mcpServerRepository,
      mcpHostFactory: factory,
      googleConnectionMode: 'disabled',
    });

    expect(factory).not.toHaveBeenCalled();
    expect(mockChangelogRepo.getForServer).not.toHaveBeenCalled();
  });

  it('does not contact an unclassified server when its cached-skill lookup fails', async () => {
    mockServerRepo.listActive.mockResolvedValue([
      makeServer({ id: 'unknown-server', registry_id: 'custom-tools' }),
    ]);
    mockServerRepo.listSkillNamesForServer.mockRejectedValue(new Error('DB unavailable'));
    const factory = vi.fn();

    await runChangelogPollJob({
      changelogRepo: mockChangelogRepo,
      serverRepo: mockServerRepo as unknown as typeof import('@skytwin/db').mcpServerRepository,
      mcpHostFactory: factory,
      googleConnectionMode: 'disabled',
    });

    expect(factory).not.toHaveBeenCalled();
    expect(mockChangelogRepo.getForServer).not.toHaveBeenCalled();
  });

  it('keeps the explicitly experimental server polling path available', async () => {
    const server = makeServer({ registry_id: 'gmail-mcp', oauth_provider: 'google' });
    mockServerRepo.listActive.mockResolvedValue([server]);
    mockChangelogRepo.getForServer.mockResolvedValue(null);
    const host = {
      installServer: vi.fn().mockResolvedValue({ success: false, error: 'offline' }),
      fetchChangelog: vi.fn(),
      listSkills: vi.fn(),
      uninstallServer: vi.fn().mockResolvedValue({ success: true }),
    };
    const factory = vi.fn(() => host as unknown as McpHost);

    await runChangelogPollJob({
      changelogRepo: mockChangelogRepo,
      serverRepo: mockServerRepo as unknown as typeof import('@skytwin/db').mcpServerRepository,
      mcpHostFactory: factory,
      googleConnectionMode: 'experimental',
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(host.installServer).toHaveBeenCalledOnce();
  });

  it('handles empty server list gracefully', async () => {
    mockServerRepo.listActive.mockResolvedValue([]);

    await expect(runChangelogPollJob({
      changelogRepo: mockChangelogRepo,
      serverRepo: mockServerRepo as unknown as typeof import('@skytwin/db').mcpServerRepository,
    })).resolves.toBeUndefined();

    expect(mockChangelogRepo.upsert).not.toHaveBeenCalled();
  });

  it('skips servers fetched within 12 hours', async () => {
    const server = makeServer({ id: 'server-1' });
    mockServerRepo.listActive.mockResolvedValue([server]);

    // fetched_at is 1 hour ago — within 12h rate limit
    mockChangelogRepo.getForServer.mockResolvedValue({
      server_id: 'server-1',
      fetched_at: new Date(Date.now() - 1 * 60 * 60 * 1000),
      last_known_destructive_skills: [],
    });

    const mockFactory = vi.fn();

    await runChangelogPollJob({
      changelogRepo: mockChangelogRepo,
      serverRepo: mockServerRepo as unknown as typeof import('@skytwin/db').mcpServerRepository,
      mcpHostFactory: mockFactory,
    });

    // Rate-limited: no host created, no upsert
    expect(mockFactory).not.toHaveBeenCalled();
    expect(mockChangelogRepo.upsert).not.toHaveBeenCalled();
  });

  it('detects new destructive skills and creates pending opt-ins', async () => {
    const server = makeServer({ id: 'server-1', display_name: 'Notion' });
    mockServerRepo.listActive.mockResolvedValue([server]);

    // No prior changelog — first fetch
    mockChangelogRepo.getForServer.mockResolvedValue(null);

    // Create a fake McpHost that knows about a new destructive skill
    const mockHost = {
      installServer: vi.fn().mockResolvedValue({ success: true }),
      fetchChangelog: vi.fn().mockResolvedValue({
        currentVersion: '1.4.0',
        rawText: '## v1.4.0\n\nAdded create_database.',
      }),
      listSkills: vi.fn().mockResolvedValue({
        success: true,
        skills: [
          { name: 'create_database' },
          { name: 'read_page' },
        ],
      }),
      uninstallServer: vi.fn().mockResolvedValue({ success: true }),
    };

    await runChangelogPollJob({
      changelogRepo: mockChangelogRepo,
      serverRepo: mockServerRepo as unknown as typeof import('@skytwin/db').mcpServerRepository,
      mcpHostFactory: () => mockHost as unknown as McpHost,
    });

    // create_database is destructive — must create opt-in
    expect(mockChangelogRepo.addPendingOptIn).toHaveBeenCalledWith(
      'server-1',
      'create_database',
      '1.4.0',
    );

    // read_page is not destructive — no opt-in
    const calls = mockChangelogRepo.addPendingOptIn.mock.calls;
    const skillNames = calls.map((c) => c[1]);
    expect(skillNames).not.toContain('read_page');

    // Upsert the changelog row
    expect(mockChangelogRepo.upsert).toHaveBeenCalledWith(
      'server-1',
      expect.objectContaining({
        currentVersion: '1.4.0',
        lastKnownDestructiveSkills: ['create_database'],
      }),
    );
  });

  it('does not create opt-ins for skills already in last_known_destructive_skills', async () => {
    const server = makeServer({ id: 'server-1' });
    mockServerRepo.listActive.mockResolvedValue([server]);

    // create_database was already known — 12h+ ago
    mockChangelogRepo.getForServer.mockResolvedValue({
      server_id: 'server-1',
      fetched_at: new Date(Date.now() - 13 * 60 * 60 * 1000),
      last_known_destructive_skills: ['create_database'],
    });

    const mockHost = {
      installServer: vi.fn().mockResolvedValue({ success: true }),
      fetchChangelog: vi.fn().mockResolvedValue({ currentVersion: '1.4.0', rawText: '## v1.4.0' }),
      listSkills: vi.fn().mockResolvedValue({
        success: true,
        skills: [{ name: 'create_database' }, { name: 'read_page' }],
      }),
      uninstallServer: vi.fn().mockResolvedValue({ success: true }),
    };

    await runChangelogPollJob({
      changelogRepo: mockChangelogRepo,
      serverRepo: mockServerRepo as unknown as typeof import('@skytwin/db').mcpServerRepository,
      mcpHostFactory: () => mockHost as unknown as McpHost,
    });

    // No new opt-ins since create_database was already known
    expect(mockChangelogRepo.addPendingOptIn).not.toHaveBeenCalled();
  });

  it('handles server connect failure gracefully and continues with other servers', async () => {
    const server1 = makeServer({ id: 'server-1' });
    const server2 = makeServer({ id: 'server-2', display_name: 'Other' });
    mockServerRepo.listActive.mockResolvedValue([server1, server2]);

    mockChangelogRepo.getForServer.mockResolvedValue(null);

    let callCount = 0;
    const mockFactory = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        // server-1 fails to connect
        return {
          installServer: vi.fn().mockResolvedValue({ success: false, error: 'connection refused' }),
          fetchChangelog: vi.fn(),
          listSkills: vi.fn(),
          uninstallServer: vi.fn(),
        } as unknown as McpHost;
      }
      // server-2 succeeds
      return {
        installServer: vi.fn().mockResolvedValue({ success: true }),
        fetchChangelog: vi.fn().mockResolvedValue(null),
        listSkills: vi.fn().mockResolvedValue({ success: true, skills: [] }),
        uninstallServer: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as McpHost;
    });

    await runChangelogPollJob({
      changelogRepo: mockChangelogRepo,
      serverRepo: mockServerRepo as unknown as typeof import('@skytwin/db').mcpServerRepository,
      mcpHostFactory: mockFactory,
    });

    // server-2 should still be upserted
    expect(mockChangelogRepo.upsert).toHaveBeenCalledWith('server-2', expect.any(Object));
  });

  it('does not fetch or persist after revocation during server installation', async () => {
    const controller = new AbortController();
    mockServerRepo.listActive.mockResolvedValue([makeServer()]);
    mockChangelogRepo.getForServer.mockResolvedValue(null);
    let releaseInstall: ((value: { success: true }) => void) | undefined;
    const install = new Promise<{ success: true }>((resolve) => {
      releaseInstall = resolve;
    });
    const mockHost = {
      installServer: vi.fn(() => install),
      fetchChangelog: vi.fn(),
      listSkills: vi.fn(),
      uninstallServer: vi.fn().mockResolvedValue({ success: true }),
    };

    const pending = runChangelogPollJob({
      changelogRepo: mockChangelogRepo,
      serverRepo: mockServerRepo as unknown as typeof import('@skytwin/db').mcpServerRepository,
      mcpHostFactory: () => mockHost as unknown as McpHost,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockHost.installServer).toHaveBeenCalledOnce());
    controller.abort(new Error('generation revoked'));
    releaseInstall?.({ success: true });

    await expect(pending).rejects.toThrow('generation revoked');
    expect(mockHost.fetchChangelog).not.toHaveBeenCalled();
    expect(mockChangelogRepo.upsert).not.toHaveBeenCalled();
    expect(mockHost.uninstallServer).toHaveBeenCalledWith('server-1');
  });
});

// ---------------------------------------------------------------------------
// isDestructiveSkill integration (quick smoke-test from worker perspective)
// ---------------------------------------------------------------------------

describe('isDestructiveSkill (worker integration)', () => {
  it('correctly identifies destructive and non-destructive skills used in job', () => {
    expect(isDestructiveSkill('create_database')).toBe(true);
    expect(isDestructiveSkill('delete_record')).toBe(true);
    expect(isDestructiveSkill('read_page')).toBe(false);
    expect(isDestructiveSkill('list_issues')).toBe(false);
  });
});
