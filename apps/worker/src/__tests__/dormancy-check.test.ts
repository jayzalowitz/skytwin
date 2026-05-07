import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @skytwin/db before importing the job
// ---------------------------------------------------------------------------

const {
  mockMcpServerRepository,
  mockAppSuggestionRepository,
} = vi.hoisted(() => ({
  mockMcpServerRepository: {
    getInactiveSince: vi.fn(),
    markDormant: vi.fn(),
  },
  mockAppSuggestionRepository: {
    upsertPending: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepository,
  appSuggestionRepository: mockAppSuggestionRepository,
}));

// ---------------------------------------------------------------------------
// Import job under test AFTER mocks are wired
// ---------------------------------------------------------------------------

import { runDormancyCheckJob } from '../jobs/dormancy-check.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMcpServer(overrides: Partial<{
  id: string;
  user_id: string;
  registry_id: string | null;
  display_name: string;
  status: string;
  last_active_at: Date | null;
  created_at: Date;
}> = {}) {
  // Use 'registryId' key in overrides but map to snake_case.
  // Note: `?? default` passes through null (null coalescing skips null).
  // We use `'registry_id' in overrides` to allow explicit null overrides.
  const registry_id = 'registry_id' in overrides ? overrides.registry_id! : '@scope/server-name';
  return {
    id: overrides.id ?? 'server-1',
    user_id: overrides.user_id ?? 'user-1',
    registry_id,
    display_name: overrides.display_name ?? 'Test Server',
    transport: 'stdio',
    command: null,
    args: [],
    env: {},
    url: null,
    oauth_provider: null,
    oauth_token_id: null,
    trust_tier: 'observer',
    per_app_spend_per_action_cents: null,
    per_app_daily_spend_cents: null,
    per_app_monthly_spend_cents: null,
    per_app_monthly_rollover: false,
    per_app_irreversible_requires_approval: null,
    zero_trust_mode: false,
    status: overrides.status ?? 'active',
    last_health_check_at: null,
    health_status: null,
    last_active_at: overrides.last_active_at ?? new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    installed_at: new Date('2026-01-01'),
    uninstalled_at: null,
    created_at: overrides.created_at ?? new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDormancyCheckJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppSuggestionRepository.upsertPending.mockResolvedValue({
      id: 'suggestion-1',
      status: 'pending',
    });
  });

  it('marks a server dormant when last_active_at is older than 30 days', async () => {
    const oldServer = makeMcpServer({
      last_active_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });
    mockMcpServerRepository.getInactiveSince.mockResolvedValue([oldServer]);
    mockMcpServerRepository.markDormant.mockResolvedValue({ ...oldServer, status: 'dormant' });

    await runDormancyCheckJob({ thresholdDays: 30 });

    expect(mockMcpServerRepository.markDormant).toHaveBeenCalledWith('server-1');
  });

  it('does NOT mark dormant when last_active_at is recent (< 30 days)', async () => {
    // getInactiveSince returns empty: the DB query filters by threshold
    mockMcpServerRepository.getInactiveSince.mockResolvedValue([]);

    await runDormancyCheckJob({ thresholdDays: 30 });

    expect(mockMcpServerRepository.markDormant).not.toHaveBeenCalled();
    expect(mockAppSuggestionRepository.upsertPending).not.toHaveBeenCalled();
  });

  it('creates a dormancy suggestion for each newly-dormant server', async () => {
    const server = makeMcpServer({
      id: 'server-2',
      user_id: 'user-2',
      registry_id: '@scope/test-server',
      display_name: 'Test Server',
      last_active_at: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000),
    });
    mockMcpServerRepository.getInactiveSince.mockResolvedValue([server]);
    mockMcpServerRepository.markDormant.mockResolvedValue({ ...server, status: 'dormant' });

    await runDormancyCheckJob({ thresholdDays: 30 });

    expect(mockAppSuggestionRepository.upsertPending).toHaveBeenCalledTimes(1);
    const call = mockAppSuggestionRepository.upsertPending.mock.calls[0]![0] as {
      userId: string;
      registryId: string;
      displayName: string;
      reasonSummary: string;
    };
    expect(call.userId).toBe('user-2');
    expect(call.registryId).toBe('@scope/test-server');
    expect(call.displayName).toBe('Test Server');
    expect(call.reasonSummary).toMatch(/Test Server/);
    expect(call.reasonSummary).toMatch(/inactive/);
  });

  it('does NOT create a duplicate suggestion (upsertPending handles the conflict guard)', async () => {
    // Even if called twice for the same server, upsertPending is idempotent via
    // its ON CONFLICT (user_id, registry_id) WHERE status='pending' clause.
    // The job calls it once per server; test that it's called exactly once.
    const server = makeMcpServer();
    mockMcpServerRepository.getInactiveSince.mockResolvedValue([server]);
    mockMcpServerRepository.markDormant.mockResolvedValue({ ...server, status: 'dormant' });

    await runDormancyCheckJob({ thresholdDays: 30 });

    // Called exactly once per server — no duplicate call
    expect(mockAppSuggestionRepository.upsertPending).toHaveBeenCalledTimes(1);
  });

  it('skips suggestion when registry_id is null', async () => {
    const server = makeMcpServer({ registry_id: null });
    mockMcpServerRepository.getInactiveSince.mockResolvedValue([server]);
    mockMcpServerRepository.markDormant.mockResolvedValue({ ...server, status: 'dormant' });

    await runDormancyCheckJob({ thresholdDays: 30 });

    expect(mockMcpServerRepository.markDormant).toHaveBeenCalledWith('server-1');
    // No suggestion without a registry_id
    expect(mockAppSuggestionRepository.upsertPending).not.toHaveBeenCalled();
  });

  it('continues processing remaining servers when markDormant throws for one', async () => {
    const server1 = makeMcpServer({ id: 'server-err' });
    const server2 = makeMcpServer({ id: 'server-ok', user_id: 'user-2', registry_id: '@scope/ok' });

    mockMcpServerRepository.getInactiveSince.mockResolvedValue([server1, server2]);
    mockMcpServerRepository.markDormant
      .mockRejectedValueOnce(new Error('DB timeout'))
      .mockResolvedValueOnce({ ...server2, status: 'dormant' });

    await runDormancyCheckJob({ thresholdDays: 30 });

    // Both were attempted
    expect(mockMcpServerRepository.markDormant).toHaveBeenCalledTimes(2);
    // Only server2 produced a suggestion
    expect(mockAppSuggestionRepository.upsertPending).toHaveBeenCalledTimes(1);
    const call = mockAppSuggestionRepository.upsertPending.mock.calls[0]![0] as { userId: string };
    expect(call.userId).toBe('user-2');
  });
});
