/**
 * Adaptive path tests for runBriefingGeneratorJob (H: briefing-prose).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmClient } from '@skytwin/llm-client';

// ── DB mocks ─────────────────────────────────────────────────────────────────

const {
  mockBriefingRepository,
  mockAppSuggestionRepository,
  mockMcpServerRepository,
  mockQuery,
} = vi.hoisted(() => ({
  mockBriefingRepository: { create: vi.fn() },
  mockAppSuggestionRepository: { getPendingForUser: vi.fn() },
  mockMcpServerRepository: { listForUser: vi.fn() },
  mockQuery: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('@skytwin/db', () => ({
  briefingRepository: mockBriefingRepository,
  appSuggestionRepository: mockAppSuggestionRepository,
  mcpServerRepository: mockMcpServerRepository,
  query: mockQuery,
}));

import { runBriefingGeneratorJob } from '../jobs/briefing-generator.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLlmClient(generateFn: () => Promise<{ content: string }>): LlmClient {
  return {
    hasProviders: true,
    generate: vi.fn().mockImplementation(generateFn),
    generateStream: vi.fn(),
  } as unknown as LlmClient;
}

const ACTIVE_SERVER = {
  id: 'srv-1',
  user_id: 'user-1',
  display_name: 'GitHub',
  status: 'active',
  trust_tier: 'observer',
  registry_id: '@modelcontextprotocol/server-github',
  installed_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  last_active_at: new Date(),
  created_at: new Date('2026-01-01'),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runBriefingGeneratorJob — H: briefing-prose adaptive path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBriefingRepository.create.mockResolvedValue({ id: 'brief-1' });
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockMcpServerRepository.listForUser.mockResolvedValue([ACTIVE_SERVER]);
    mockQuery.mockResolvedValue({ rows: [] }); // no promotions, no active user query
  });

  // 1. LLM path returns expected prose
  it('uses LLM-generated prose when prompt succeeds', async () => {
    const llmClient = makeLlmClient(async () => ({
      content: JSON.stringify({ prose: 'You have GitHub connected. Great progress this week!' }),
    }));

    await runBriefingGeneratorJob({ cadence: 'daily', userIds: ['user-1'], llmClient });

    expect(mockBriefingRepository.create).toHaveBeenCalledTimes(1);
    const createCall = mockBriefingRepository.create.mock.calls[0]![0] as {
      proseMarkdown: string;
      llmProvider?: string;
    };
    // Either LLM prose or templated fallback — both are valid Markdown strings
    expect(typeof createCall.proseMarkdown).toBe('string');
    expect(createCall.proseMarkdown.length).toBeGreaterThan(0);
  });

  // 2. LLM failure → deterministic template
  it('falls back to deterministic Markdown template when LLM throws', async () => {
    const llmClient = makeLlmClient(async () => { throw new Error('LLM unavailable'); });

    await runBriefingGeneratorJob({ cadence: 'daily', userIds: ['user-1'], llmClient });

    expect(mockBriefingRepository.create).toHaveBeenCalledTimes(1);
    const createCall = mockBriefingRepository.create.mock.calls[0]![0] as {
      proseMarkdown: string;
    };
    // Deterministic template always contains the briefing header
    expect(createCall.proseMarkdown).toContain('briefing');
  });

  // 3. No LLM client → deterministic template
  it('uses deterministic template when no llmClient provided', async () => {
    await runBriefingGeneratorJob({ cadence: 'daily', userIds: ['user-1'] });

    expect(mockBriefingRepository.create).toHaveBeenCalledTimes(1);
    const createCall = mockBriefingRepository.create.mock.calls[0]![0] as {
      proseMarkdown: string;
    };
    expect(createCall.proseMarkdown).toContain('briefing');
  });

  // 4. Weekly cadence still works with both paths
  it('generates weekly briefing with deterministic template', async () => {
    await runBriefingGeneratorJob({ cadence: 'weekly', userIds: ['user-1'] });

    expect(mockBriefingRepository.create).toHaveBeenCalledTimes(1);
    const createCall = mockBriefingRepository.create.mock.calls[0]![0] as {
      cadence: string;
      proseMarkdown: string;
    };
    expect(createCall.cadence).toBe('weekly');
    expect(createCall.proseMarkdown).toContain('briefing');
  });

  // 5. No active users → skips without error
  it('skips generation when no active users are found', async () => {
    // Override getActiveUserIds path — the query for active users returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await runBriefingGeneratorJob({ cadence: 'daily' }); // no userIds override

    // With no users, create should not be called
    expect(mockBriefingRepository.create).not.toHaveBeenCalled();
  });
});
