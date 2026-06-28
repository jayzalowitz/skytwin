/**
 * Tests for the briefing generator worker job (issue #177).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────

const {
  mockBriefingRepository,
  mockAppSuggestionRepository,
  mockMemoryActionOpportunityRepository,
  mockMcpServerRepository,
  mockLifebookRepository,
  mockQuery,
} = vi.hoisted(() => ({
  mockBriefingRepository: {
    create: vi.fn(),
    getLatestForUser: vi.fn(),
    getLatestForUserDomain: vi.fn(),
    listForUser: vi.fn(),
    markRead: vi.fn(),
  },
  mockAppSuggestionRepository: {
    getPendingForUser: vi.fn(),
    getActiveForUser: vi.fn(),
    markDismissed: vi.fn(),
    markSnoozed: vi.fn(),
  },
  mockMemoryActionOpportunityRepository: {
    listRecentReportsForUser: vi.fn(),
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
  mockLifebookRepository: {
    listVisible: vi.fn(),
    upsert: vi.fn(),
    getByUserAndDomain: vi.fn(),
    hide: vi.fn(),
    unhide: vi.fn(),
  },
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  briefingRepository: mockBriefingRepository,
  appSuggestionRepository: mockAppSuggestionRepository,
  memoryActionOpportunityRepository: mockMemoryActionOpportunityRepository,
  mcpServerRepository: mockMcpServerRepository,
  lifebookRepository: mockLifebookRepository,
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
    // Default: user has no lifebooks (no per-domain briefings written).
    // Tests that exercise the per-domain path override this.
    mockLifebookRepository.listVisible.mockResolvedValue([]);
    mockMemoryActionOpportunityRepository.listRecentReportsForUser.mockResolvedValue([]);
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

  it('includes memory-derived action opportunities in the generated report', async () => {
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            bucket: 'recent',
            id: 'page-recent',
            title: 'voice/note',
            content: 'I will send the Madrid launch checklist to the team tomorrow morning.',
            source: 'signal',
            source_ref: 'sig-recent',
            metadata: { signalSource: 'voice', authoringTier: 'user_sent_originated' },
            created_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // no promotion rows
    mockBriefingRepository.create.mockResolvedValue({
      id: 'briefing-memory',
      user_id: 'user-memory',
      cadence: 'daily',
      generated_at: new Date(),
      prose_markdown: '',
      source_event_count: 1,
      llm_provider: null,
      llm_cost_cents: null,
      read_at: null,
    });

    await runBriefingGeneratorJob({ cadence: 'daily', userIds: ['user-memory'] });

    expect(mockBriefingRepository.create).toHaveBeenCalledOnce();
    const createArg = mockBriefingRepository.create.mock.calls[0]?.[0];
    expect(createArg.proseMarkdown).toContain('### Action opportunities from memory');
    expect(createArg.proseMarkdown).toContain('Madrid launch checklist');
    expect(createArg.proseMarkdown).toContain('ironclaw');
    expect(createArg.proseMarkdown).toContain('IronClaw 0.29.1');
    expect(createArg.sourceEventCount).toBe(1);
  });

  it('includes memory action loop results in the generated report', async () => {
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockMemoryActionOpportunityRepository.listRecentReportsForUser.mockResolvedValue([
      {
        opportunityId: 'opp-1',
        status: 'queued_approval',
        title: 'Madrid launch checklist',
        actionType: 'create_task',
        actionLabel: 'create a follow-up task',
        summary: 'SkyTwin prepared this memory action and queued it for approval.',
        nextStep: 'Review the approval request.',
        attemptedAt: '2026-06-25T12:00:00.000Z',
      },
      {
        opportunityId: 'opp-2',
        status: 'noted_awareness',
        title: 'Acme Weekly — issue 42',
        actionType: 'create_note',
        actionLabel: 'note your interest in this topic',
        summary: 'SkyTwin noted this as awareness — no approval needed and nothing was executed.',
        nextStep: 'Nothing required.',
        attemptedAt: '2026-06-25T12:05:00.000Z',
      },
    ]);
    mockBriefingRepository.create.mockResolvedValue({
      id: 'briefing-loop',
      user_id: 'user-loop',
      cadence: 'daily',
      generated_at: new Date(),
      prose_markdown: '',
      source_event_count: 1,
      llm_provider: null,
      llm_cost_cents: null,
      read_at: null,
    });

    await runBriefingGeneratorJob({ cadence: 'daily', userIds: ['user-loop'] });

    const createArg = mockBriefingRepository.create.mock.calls[0]?.[0];
    expect(createArg.proseMarkdown).toContain('### Memory action loop');
    // Status renders as a plain-language label, not the raw enum (no jargon in UI).
    expect(createArg.proseMarkdown).toContain('waiting for your OK');
    expect(createArg.proseMarkdown).not.toContain('queued_approval');
    expect(createArg.proseMarkdown).toContain('noted as FYI');
    expect(createArg.proseMarkdown).toContain('Review the approval request');
    expect(createArg.sourceEventCount).toBe(2); // two memory-loop reports now
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

  // ── #193 follow-up: per-Lifebook briefings ───────────────────────────────

  it('emits a per-Lifebook briefing for each visible lifebook with matching events', async () => {
    const healthServer = makeServer({
      id: 'srv-health',
      user_id: 'user-poly',
      registry_id: 'fitbit-mcp',
      display_name: 'Fitbit',
    });
    const moneyServer = makeServer({
      id: 'srv-money',
      user_id: 'user-poly',
      registry_id: 'mint-mcp',
      display_name: 'Mint',
    });
    mockMcpServerRepository.listForUser.mockResolvedValue([healthServer, moneyServer]);
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockLifebookRepository.listVisible.mockResolvedValue([
      {
        id: 'lb-health',
        user_id: 'user-poly',
        domain_name: 'Health',
        importance: 'core',
        sample_signals: [],
        suggested_capabilities: ['fitbit-mcp'],
        wing_id: 'wing-h',
        detected_at: new Date(),
        last_seen_at: new Date(),
        hidden_at: null,
      },
      {
        id: 'lb-money',
        user_id: 'user-poly',
        domain_name: 'Money',
        importance: 'core',
        sample_signals: [],
        suggested_capabilities: ['mint-mcp'],
        wing_id: 'wing-m',
        detected_at: new Date(),
        last_seen_at: new Date(),
        hidden_at: null,
      },
    ]);
    mockBriefingRepository.create.mockImplementation(async (input) => ({
      id: 'briefing-x',
      user_id: input.userId,
      cadence: input.cadence,
      generated_at: new Date(),
      prose_markdown: input.proseMarkdown,
      source_event_count: input.sourceEventCount,
      llm_provider: input.llmProvider ?? null,
      llm_cost_cents: input.llmCostCents ?? null,
      read_at: null,
      domain_name: input.domainName ?? null,
    }));

    await runBriefingGeneratorJob({ cadence: 'daily', userIds: ['user-poly'] });

    // 1 global + 2 per-Lifebook = 3 create calls.
    expect(mockBriefingRepository.create).toHaveBeenCalledTimes(3);
    const calls = mockBriefingRepository.create.mock.calls.map((c) => c[0]);
    const globalCall = calls.find((c) => c.domainName === undefined);
    const healthCall = calls.find((c) => c.domainName === 'Health');
    const moneyCall = calls.find((c) => c.domainName === 'Money');
    expect(globalCall).toBeDefined();
    expect(healthCall).toBeDefined();
    expect(moneyCall).toBeDefined();
    // Each per-Lifebook briefing should mention the scoped capability name.
    expect(healthCall!.proseMarkdown).toContain('Fitbit');
    expect(moneyCall!.proseMarkdown).toContain('Mint');
  });

  it('skips per-Lifebook emission when the lifebook has no events in the window', async () => {
    // User has one active server (Linear) but a Health lifebook whose
    // suggested_capabilities don't include it. The filter should
    // collapse to zero events → no per-domain briefing written.
    const server = makeServer({ user_id: 'user-empty-lb' });
    mockMcpServerRepository.listForUser.mockResolvedValue([server]);
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockLifebookRepository.listVisible.mockResolvedValue([
      {
        id: 'lb-health',
        user_id: 'user-empty-lb',
        domain_name: 'Health',
        importance: 'core',
        sample_signals: [],
        suggested_capabilities: ['unrelated-mcp'],
        wing_id: 'wing-h',
        detected_at: new Date(),
        last_seen_at: new Date(),
        hidden_at: null,
      },
    ]);
    mockBriefingRepository.create.mockImplementation(async (input) => ({
      id: 'briefing-y',
      user_id: input.userId,
      cadence: input.cadence,
      generated_at: new Date(),
      prose_markdown: input.proseMarkdown,
      source_event_count: input.sourceEventCount,
      llm_provider: null,
      llm_cost_cents: null,
      read_at: null,
      domain_name: input.domainName ?? null,
    }));

    await runBriefingGeneratorJob({ cadence: 'daily', userIds: ['user-empty-lb'] });

    // Only the global briefing is written — Health gets skipped.
    expect(mockBriefingRepository.create).toHaveBeenCalledTimes(1);
    const onlyCall = mockBriefingRepository.create.mock.calls[0]?.[0];
    expect(onlyCall.domainName).toBeUndefined();
  });

  it('continues writing other per-Lifebook briefings when one lifebook throws', async () => {
    const healthServer = makeServer({
      id: 'srv-h',
      user_id: 'user-resilient',
      registry_id: 'fitbit-mcp',
    });
    const moneyServer = makeServer({
      id: 'srv-m',
      user_id: 'user-resilient',
      registry_id: 'mint-mcp',
    });
    mockMcpServerRepository.listForUser.mockResolvedValue([healthServer, moneyServer]);
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockLifebookRepository.listVisible.mockResolvedValue([
      {
        id: 'lb-health',
        user_id: 'user-resilient',
        domain_name: 'Health',
        importance: 'core',
        sample_signals: [],
        suggested_capabilities: ['fitbit-mcp'],
        wing_id: 'wing-h',
        detected_at: new Date(),
        last_seen_at: new Date(),
        hidden_at: null,
      },
      {
        id: 'lb-money',
        user_id: 'user-resilient',
        domain_name: 'Money',
        importance: 'core',
        sample_signals: [],
        suggested_capabilities: ['mint-mcp'],
        wing_id: 'wing-m',
        detected_at: new Date(),
        last_seen_at: new Date(),
        hidden_at: null,
      },
    ]);
    // First per-domain create (Health) throws; the rest must still go through.
    let createCallIdx = 0;
    mockBriefingRepository.create.mockImplementation(async (input) => {
      createCallIdx++;
      if (createCallIdx === 2) {
        throw new Error('simulated Health write failure');
      }
      return {
        id: `briefing-${createCallIdx}`,
        user_id: input.userId,
        cadence: input.cadence,
        generated_at: new Date(),
        prose_markdown: input.proseMarkdown,
        source_event_count: input.sourceEventCount,
        llm_provider: null,
        llm_cost_cents: null,
        read_at: null,
        domain_name: input.domainName ?? null,
      };
    });

    await runBriefingGeneratorJob({ cadence: 'daily', userIds: ['user-resilient'] });

    // Global + Health (threw) + Money = 3 attempts; one threw but the
    // job didn't abort, so Money still landed.
    expect(mockBriefingRepository.create).toHaveBeenCalledTimes(3);
    const written = mockBriefingRepository.create.mock.calls.map((c) => c[0].domainName);
    expect(written).toContain('Money');
  });
});
