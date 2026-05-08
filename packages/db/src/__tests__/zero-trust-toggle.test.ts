import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the connection module before importing the repository.
// ---------------------------------------------------------------------------
const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { mcpServerRepository } = await import('../repositories/mcp-server-repository.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeMcpServerRow(zero_trust_mode: boolean) {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    user_id: 'ffffffff-0000-0000-0000-000000000001',
    registry_id: '@test/server',
    display_name: 'Test Server',
    transport: 'stdio' as const,
    command: null,
    args: [],
    env: {},
    url: null,
    oauth_provider: null,
    oauth_token_id: null,
    trust_tier: 'observer' as const,
    per_app_spend_per_action_cents: null,
    per_app_daily_spend_cents: null,
    per_app_monthly_spend_cents: null,
    per_app_monthly_rollover: false,
    per_app_irreversible_requires_approval: null,
    zero_trust_mode,
    status: 'active' as const,
    last_health_check_at: null,
    health_status: null,
    last_active_at: null,
    installed_at: null,
    uninstalled_at: null,
    auto_promote_paused_until: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mcpServerRepository.setZeroTrustMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables zero_trust_mode and returns the updated row', async () => {
    const updated = fakeMcpServerRow(true);
    mockQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const result = await mcpServerRepository.setZeroTrustMode(updated.id, true);

    expect(result).not.toBeNull();
    expect(result?.zero_trust_mode).toBe(true);
  });

  it('disables zero_trust_mode and returns the updated row', async () => {
    const updated = fakeMcpServerRow(false);
    mockQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const result = await mcpServerRepository.setZeroTrustMode(updated.id, false);

    expect(result).not.toBeNull();
    expect(result?.zero_trust_mode).toBe(false);
  });

  it('returns null when the server row does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await mcpServerRepository.setZeroTrustMode('nonexistent-id', true);

    expect(result).toBeNull();
  });

  it('issues an UPDATE … RETURNING * query with correct parameters', async () => {
    const serverId = 'aaaaaaaa-0000-0000-0000-000000000001';
    mockQuery.mockResolvedValueOnce({ rows: [fakeMcpServerRow(true)], rowCount: 1 });

    await mcpServerRepository.setZeroTrustMode(serverId, true);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE mcp_servers/i);
    expect(sql).toMatch(/zero_trust_mode/i);
    expect(sql).toMatch(/RETURNING/i);
    expect(params[0]).toBe(true);
    expect(params[1]).toBe(serverId);
  });
});
