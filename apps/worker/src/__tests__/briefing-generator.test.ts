/**
 * Tests for the briefing generator worker job (issue #177).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────

const {
  mockBriefingRepository,
  mockAppSuggestionRepository,
  mockMcpServerRepository,
  mockQuery,
} = vi.hoisted(() => ({
  mockBriefingRepository: {
    create: vi.fn(),
    getLatestForUser: vi.fn(),
    listForUser: vi.fn(),
    markRead: vi.fn(),
  },
  mockAppSuggestionRepository: {
    getPendingForUser: vi.fn(),
    getActiveForUser: vi.fn(),
    markDismissed: vi.fn(),
    markSnoozed: vi.fn(),
  },
  mockMcpServerRepository: {
    listForUser: vi.fn(),
    listActive: vi.fn(),
    getInactiveSince: vi.fn(),
    getById: vi.fn(),
    markDormant: vi.fn(),
    markPaused: vi.fn(),
    markActive: vi.fn(),
    softDelete: vi.fn(),
    updateTrustTier: vi.fn(),
    pauseAutoPromotion: vi.fn(),
    getByUserAndRegistry: vi.fn(),
    markAllPausedForUser: vi.fn(),
    markAllResumedForUser: vi.fn(),
    updateLastActive: vi.fn(),
  },
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  briefingRepository: mockBriefingRepository,
  appSuggestionRepository: mockAppSuggestionRepository,
  mcpServerRepository: mockMcpServerRepository,
  query: mockQuery,
}));

// ── Import after mocks ─────────────────────────────────────────────────────

import { runBriefingGeneratorJob } from '../jobs/briefing-generator.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeServer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'server-001',
    user_id: 'user-001',
    registry_id: 'linear-mcp',
    display_name: 'Linear',
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
    status: 'active',
    last_health_check_at: null,
    health_status: null,
    last_active_at: new Date(),
    installed_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    uninstalled_at: null,
    auto_promote_paused_until: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('runBriefingGeneratorJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no provenance nodes for promotions
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('generates a daily briefing for an active user with an installed server', async () => {
    const server = makeServer();
    mockMcpServerRepository.listForUser.mockResolvedValue([server]);
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockBriefingRepository.create.mockResolvedValue({
      id: 'briefing-001',
      user_id: 'user-001',
      cadence: 'daily',
      generated_at: new Date(),
      prose_markdown: '## Daily Briefing\n\nActive capabilities (1)',
      source_event_count: 0,
      llm_provider: null,
      llm_cost_cents: null,
      read_at: null,
    });

    await runBriefingGeneratorJob({ cadence: 'daily', userIds: ['user-001'] });

    expect(mockBriefingRepository.create).toHaveBeenCalledOnce();
    const createArg = mockBriefingRepository.create.mock.calls[0]?.[0];
    expect(createArg.userId).toBe('user-001');
    expect(createArg.cadence).toBe('daily');
    expect(createArg.proseMarkdown).toContain('Linear');
  });

  it('handles a user with no events gracefully (writes a placeholder briefing)', async () => {
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockBriefingRepository.create.mockResolvedValue({
      id: 'briefing-002',
      user_id: 'user-empty',
      cadence: 'daily',
      generated_at: new Date(),
      prose_markdown: '## Daily Briefing\n\nNothing new to report.',
      source_event_count: 0,
      llm_provider: null,
      llm_cost_cents: null,
      read_at: null,
    });

    await runBriefingGeneratorJob({ cadence: 'daily', userIds: ['user-empty'] });

    expect(mockBriefingRepository.create).toHaveBeenCalledOnce();
    const prose = mockBriefingRepository.create.mock.calls[0]?.[0].proseMarkdown;
    expect(prose).toContain('Nothing new');
  });

  it('writes a briefing to the briefings table (create is called)', async () => {
    const server = makeServer({ user_id: 'user-002' });
    mockMcpServerRepository.listForUser.mockResolvedValue([server]);
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockBriefingRepository.create.mockResolvedValue({
      id: 'briefing-003',
      user_id: 'user-002',
      cadence: 'weekly',
      generated_at: new Date(),
      prose_markdown: '## Weekly Briefing',
      source_event_count: 0,
      llm_provider: null,
      llm_cost_cents: null,
      read_at: null,
    });

    await runBriefingGeneratorJob({ cadence: 'weekly', userIds: ['user-002'] });

    expect(mockBriefingRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cadence: 'weekly',
        userId: 'user-002',
        proseMarkdown: expect.any(String),
        sourceEventCount: expect.any(Number),
      }),
    );
  });

  it('skips with no side-effects when userIds is empty', async () => {
    await runBriefingGeneratorJob({ cadence: 'daily', userIds: [] });

    expect(mockBriefingRepository.create).not.toHaveBeenCalled();
    expect(mockMcpServerRepository.listForUser).not.toHaveBeenCalled();
  });
});
