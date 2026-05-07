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
    registry_id: null,
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
    oauth_provider: null,
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
});

describe('runChangelogPollJob', () => {
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
