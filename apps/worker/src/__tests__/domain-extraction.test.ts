/**
 * Tests for the domain-extraction worker (#193 Child 1).
 *
 * The worker spans three subsystems (DB query, runPrompt, mempalace +
 * lifebook repos). All three are mocked so tests cover the orchestration
 * and parsing logic without spinning up DB or LLM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmClient } from '@skytwin/llm-client';

const {
  mockLifebookRepository,
  mockMempalaceRepository,
  mockQuery,
} = vi.hoisted(() => ({
  mockLifebookRepository: {
    upsert: vi.fn(),
    listVisible: vi.fn(),
  },
  mockMempalaceRepository: {
    getWingByName: vi.fn(),
    createWing: vi.fn(),
  },
  mockQuery: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('@skytwin/db', () => ({
  lifebookRepository: mockLifebookRepository,
  mempalaceRepository: mockMempalaceRepository,
  query: mockQuery,
}));

const { mockRunPrompt } = vi.hoisted(() => ({
  mockRunPrompt: vi.fn(),
}));

vi.mock('@skytwin/policy-prompts', () => ({
  runPrompt: mockRunPrompt,
}));

import {
  extractDomainsForUser,
  formatMemorySummary,
  runDomainExtractionJob,
} from '../jobs/domain-extraction.js';

function makeLlmClient(): LlmClient {
  return {
    hasProviders: true,
    generate: vi.fn(),
    generateStream: vi.fn(),
  } as unknown as LlmClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLifebookRepository.upsert.mockResolvedValue({ id: 'lb-1' });
  mockMempalaceRepository.getWingByName.mockResolvedValue(null);
  mockMempalaceRepository.createWing.mockImplementation(async (input) => ({
    id: `wing-${input.name}`,
    user_id: input.userId,
    name: input.name,
    description: input.description,
    domains: input.domains,
  }));
});

describe('formatMemorySummary', () => {
  it('renders entities and triples in a stable order', () => {
    const out = formatMemorySummary({
      topEntities: [
        { kind: 'sender', canonical: 'alice@example.com', freq: 12 },
        { kind: 'organization', canonical: 'Acme Corp', freq: 4 },
      ],
      recentTriples: [
        { subject: 'user', predicate: 'works_at', object: 'Acme Corp' },
      ],
      drawerCount: 50,
      wingCount: 3,
    });
    expect(out).toContain('3 wings, 50 drawers');
    expect(out).toContain('[sender] alice@example.com (×12)');
    expect(out).toContain('user —[works_at]→ Acme Corp');
  });

  it('omits sections with no data', () => {
    const out = formatMemorySummary({
      topEntities: [],
      recentTriples: [],
      drawerCount: 0,
      wingCount: 0,
    });
    expect(out).not.toContain('## Top entities');
    expect(out).not.toContain('## Recent triples');
  });
});

describe('extractDomainsForUser', () => {
  it('returns 0/0 when user has no memory yet', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // entities
      .mockResolvedValueOnce({ rows: [] }) // triples
      .mockResolvedValueOnce({ rows: [{ wing_count: '0', drawer_count: '0' }] });

    const result = await extractDomainsForUser('user-1', makeLlmClient(), ['email']);
    expect(result).toEqual({ detected: 0, persisted: 0 });
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('returns 0/0 when no LlmClient is provided (LLM-dependent)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ kind: 'org', canonical: 'X', freq: '5' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ wing_count: '1', drawer_count: '5' }] });

    const result = await extractDomainsForUser('user-1', undefined, ['email']);
    expect(result).toEqual({ detected: 0, persisted: 0 });
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('persists each detected domain and creates a wing per domain', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ kind: 'sender', canonical: 'a@b.com', freq: '7' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ wing_count: '1', drawer_count: '8' }] });

    mockRunPrompt.mockResolvedValue({
      output: [
        {
          domainName: 'Software Development',
          importance: 'core',
          sample_signals: ['github commit', 'code review'],
          suggested_capabilities: ['code', 'project-management'],
        },
        {
          domainName: 'Personal Finance',
          importance: 'secondary',
          sample_signals: ['receipt'],
          suggested_capabilities: ['finance'],
        },
      ],
      cached: false,
      latencyMs: 100,
      fellBackToDeterministic: false,
    });

    const result = await extractDomainsForUser('user-1', makeLlmClient(), ['code', 'finance']);
    expect(result).toEqual({ detected: 2, persisted: 2 });

    expect(mockMempalaceRepository.createWing).toHaveBeenCalledTimes(2);
    expect(mockMempalaceRepository.createWing).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Software Development', userId: 'user-1' }),
    );
    expect(mockLifebookRepository.upsert).toHaveBeenCalledTimes(2);
    expect(mockLifebookRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        domainName: 'Software Development',
        importance: 'core',
        wingId: 'wing-Software Development',
      }),
    );
  });

  it('reuses an existing wing instead of creating a duplicate', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ kind: 'X', canonical: 'Y', freq: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ wing_count: '1', drawer_count: '1' }] });

    mockMempalaceRepository.getWingByName.mockResolvedValue({
      id: 'existing-wing',
      user_id: 'user-1',
      name: 'Travel',
    });

    mockRunPrompt.mockResolvedValue({
      output: [
        {
          domainName: 'Travel',
          importance: 'emerging',
          sample_signals: ['flight booking'],
          suggested_capabilities: ['travel'],
        },
      ],
      cached: false,
      latencyMs: 100,
      fellBackToDeterministic: false,
    });

    await extractDomainsForUser('user-1', makeLlmClient(), ['travel']);
    expect(mockMempalaceRepository.createWing).not.toHaveBeenCalled();
    expect(mockLifebookRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ wingId: 'existing-wing' }),
    );
  });

  it('skips invalid domain entries from the prompt', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ kind: 'X', canonical: 'Y', freq: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ wing_count: '1', drawer_count: '1' }] });

    mockRunPrompt.mockResolvedValue({
      output: [
        { domainName: 'OK', importance: 'core', sample_signals: [], suggested_capabilities: [] },
        { domainName: 123, importance: 'core' }, // invalid
        { importance: 'core', sample_signals: [], suggested_capabilities: [] }, // missing name
        null, // invalid
      ],
      cached: false,
      latencyMs: 100,
      fellBackToDeterministic: false,
    });

    const result = await extractDomainsForUser('user-1', makeLlmClient(), ['x']);
    expect(result.detected).toBe(1);
    expect(mockLifebookRepository.upsert).toHaveBeenCalledTimes(1);
  });

  it('handles non-array prompt output gracefully', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ kind: 'X', canonical: 'Y', freq: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ wing_count: '1', drawer_count: '1' }] });

    mockRunPrompt.mockResolvedValue({
      output: 'not an array',
      cached: false,
      latencyMs: 100,
      fellBackToDeterministic: true,
    });

    const result = await extractDomainsForUser('user-1', makeLlmClient(), ['x']);
    expect(result).toEqual({ detected: 0, persisted: 0 });
  });

  it('caps detected domains at 10 even if prompt over-produces', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ kind: 'X', canonical: 'Y', freq: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ wing_count: '1', drawer_count: '1' }] });

    const fifteen = Array.from({ length: 15 }, (_, i) => ({
      domainName: `D${i}`,
      importance: 'emerging',
      sample_signals: [],
      suggested_capabilities: [],
    }));
    mockRunPrompt.mockResolvedValue({
      output: fifteen,
      cached: false,
      latencyMs: 100,
      fellBackToDeterministic: false,
    });

    const result = await extractDomainsForUser('user-1', makeLlmClient(), ['x']);
    expect(result.detected).toBe(10);
    expect(mockLifebookRepository.upsert).toHaveBeenCalledTimes(10);
  });

  it('continues on per-domain persist failures and returns accurate counts', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ kind: 'X', canonical: 'Y', freq: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ wing_count: '1', drawer_count: '1' }] });

    mockRunPrompt.mockResolvedValue({
      output: [
        { domainName: 'A', importance: 'core', sample_signals: [], suggested_capabilities: [] },
        { domainName: 'B', importance: 'core', sample_signals: [], suggested_capabilities: [] },
      ],
      cached: false,
      latencyMs: 100,
      fellBackToDeterministic: false,
    });

    mockLifebookRepository.upsert
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'lb-2' });

    const result = await extractDomainsForUser('user-1', makeLlmClient(), ['x']);
    expect(result.detected).toBe(2);
    expect(result.persisted).toBe(1);
  });
});

describe('runDomainExtractionJob', () => {
  it('skips when no active users are found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await runDomainExtractionJob({ llmClient: makeLlmClient() });
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('processes each provided userId and absorbs per-user errors', async () => {
    // For each user the inner function will issue 3 queries; rig 6 in advance.
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // user-1 entities
      .mockResolvedValueOnce({ rows: [] }) // user-1 triples
      .mockResolvedValueOnce({ rows: [{ wing_count: '0', drawer_count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ kind: 'X', canonical: 'Y', freq: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ wing_count: '1', drawer_count: '1' }] });

    mockRunPrompt.mockResolvedValueOnce({
      output: [
        { domainName: 'Test', importance: 'core', sample_signals: [], suggested_capabilities: [] },
      ],
      cached: false,
      latencyMs: 100,
      fellBackToDeterministic: false,
    });

    await runDomainExtractionJob({
      userIds: ['user-1', 'user-2'],
      llmClient: makeLlmClient(),
    });

    // user-1 short-circuits (no memory); user-2 hits the prompt path.
    expect(mockRunPrompt).toHaveBeenCalledTimes(1);
    expect(mockLifebookRepository.upsert).toHaveBeenCalledTimes(1);
  });
});
