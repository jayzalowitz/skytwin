import { describe, it, expect, vi, beforeEach } from 'vitest';
import { whoami } from '../tools/whoami.js';
import { getPreferences } from '../tools/get-preferences.js';
import { proposeAction } from '../tools/propose-action.js';
import { subscribeSignals } from '../tools/subscribe-signals.js';
import { queryMemory } from '../tools/query-memory.js';

// ─── DB mocks ────────────────────────────────────────────────────────────────
vi.mock('@skytwin/db', () => ({
  userRepository: {
    findById: vi.fn(),
  },
  mcpServerRepository: {
    listForUser: vi.fn().mockResolvedValue([]),
  },
  twinRepository: {
    getProfile: vi.fn(),
  },
  decisionRepository: {
    create: vi.fn().mockResolvedValue({ id: 'decision-abc' }),
    addCandidateAction: vi.fn().mockResolvedValue({ id: 'action-abc' }),
    recordOutcome: vi.fn().mockResolvedValue({ id: 'outcome-abc' }),
  },
  signalRepository: {
    getRecent: vi.fn(),
  },
  mempalaceRepository: {
    searchDrawers: vi.fn().mockResolvedValue([]),
    searchEpisodes: vi.fn().mockResolvedValue([]),
  },
}));

// No longer using @skytwin/memory-mempalace — query_memory now uses mempalaceRepository directly

// ─── helpers ─────────────────────────────────────────────────────────────────
function textContent(result: Awaited<ReturnType<typeof whoami>>): string {
  const first = result.content?.[0];
  if (!first || first.type !== 'text') return '';
  return first.text;
}

function parseResult(result: Awaited<ReturnType<typeof whoami>>): unknown {
  return JSON.parse(textContent(result));
}

const USER_ID = 'test-user-id';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── whoami ──────────────────────────────────────────────────────────────────
describe('whoami', () => {
  it('returns userId, displayName, twinIdentity', async () => {
    const { userRepository } = await import('@skytwin/db');
    vi.mocked(userRepository.findById).mockResolvedValueOnce({
      id: USER_ID,
      name: 'Alice',
      email: 'alice@example.com',
      trust_tier: 'suggest',
    } as never);

    const result = await whoami(USER_ID);
    expect(result.isError).toBeFalsy();
    const data = parseResult(result) as Record<string, unknown>;
    expect(data['userId']).toBe(USER_ID);
    expect(data['displayName']).toBe('Alice');
    expect(data['twinIdentity']).toMatchObject({ trustTier: 'suggest' });
  });

  it('returns isError when user not found', async () => {
    const { userRepository } = await import('@skytwin/db');
    vi.mocked(userRepository.findById).mockResolvedValueOnce(null);

    const result = await whoami(USER_ID);
    expect(result.isError).toBe(true);
  });
});

// ─── get_preferences ─────────────────────────────────────────────────────────
describe('get_preferences', () => {
  it('returns empty preferences when no twin profile exists', async () => {
    const { twinRepository } = await import('@skytwin/db');
    vi.mocked(twinRepository.getProfile).mockResolvedValueOnce(null);

    const result = await getPreferences(USER_ID, {});
    const data = parseResult(result) as Record<string, unknown>;
    expect(Array.isArray(data['preferences'])).toBe(true);
    expect((data['preferences'] as unknown[]).length).toBe(0);
  });

  it('returns preferences array from profile', async () => {
    const { twinRepository } = await import('@skytwin/db');
    vi.mocked(twinRepository.getProfile).mockResolvedValueOnce({
      id: 'p1',
      user_id: USER_ID,
      preferences: [{ domain: 'email', value: 'archive_junk' }],
      domain_heuristics: {},
    } as never);

    const result = await getPreferences(USER_ID, {});
    const data = parseResult(result) as Record<string, unknown>;
    expect(Array.isArray(data['preferences'])).toBe(true);
    expect((data['preferences'] as unknown[]).length).toBe(1);
  });

  it('filters preferences by domain', async () => {
    const { twinRepository } = await import('@skytwin/db');
    vi.mocked(twinRepository.getProfile).mockResolvedValueOnce({
      id: 'p1',
      user_id: USER_ID,
      preferences: [
        { domain: 'email', value: 'archive_junk' },
        { domain: 'calendar', value: 'accept_standup' },
      ],
      domain_heuristics: {},
    } as never);

    const result = await getPreferences(USER_ID, { domain: 'email' });
    const data = parseResult(result) as Record<string, unknown>;
    const prefs = data['preferences'] as Array<Record<string, unknown>>;
    expect(prefs.every((p) => p['domain'] === 'email')).toBe(true);
  });
});

// ─── propose_action ──────────────────────────────────────────────────────────
describe('propose_action', () => {
  it('creates a decision with pending_approval status — NEVER auto-executes', async () => {
    const { decisionRepository } = await import('@skytwin/db');
    const result = await proposeAction(USER_ID, {
      action: {
        type: 'send_email',
        parameters: { to: 'bob@example.com', subject: 'Hello' },
        reasoning: 'The user asked me to draft an email',
      },
      sourceAgent: 'claude-desktop',
    });

    const data = parseResult(result) as Record<string, unknown>;
    expect(data['status']).toBe('pending_approval');
    expect(data['decisionId']).toBeDefined();

    // Verify auto_executed is ALWAYS false (hard rail)
    expect(decisionRepository.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        autoExecuted: false,     // HARD RAIL
        requiresApproval: true,  // HARD RAIL
      }),
    );
  });

  it('returns error when action.type is missing', async () => {
    const result = await proposeAction(USER_ID, {
      action: { type: '', parameters: {}, reasoning: 'test' },
      sourceAgent: 'claude-desktop',
    });
    expect(result.isError).toBe(true);
  });

  it('returns error when reasoning is missing', async () => {
    const result = await proposeAction(USER_ID, {
      action: { type: 'send_email', parameters: {}, reasoning: '' },
      sourceAgent: 'claude-desktop',
    });
    expect(result.isError).toBe(true);
  });

  it('scopes the decision to the authenticated userId (no cross-user write)', async () => {
    const { decisionRepository } = await import('@skytwin/db');
    await proposeAction(USER_ID, {
      action: {
        type: 'test_action',
        parameters: {},
        reasoning: 'Testing scoping',
      },
      sourceAgent: 'cursor',
    });

    expect(decisionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
    );
  });
});

// ─── subscribe_signals ────────────────────────────────────────────────────────
describe('subscribe_signals', () => {
  it('returns signals array scoped to userId', async () => {
    const { signalRepository } = await import('@skytwin/db');
    vi.mocked(signalRepository.getRecent).mockResolvedValueOnce([
      { id: 'sig-1', user_id: USER_ID, type: 'email', domain: 'email', timestamp: new Date(), created_at: new Date() } as never,
    ]);

    const result = await subscribeSignals(USER_ID, {});
    const data = parseResult(result) as Record<string, unknown>;
    expect(Array.isArray(data['signals'])).toBe(true);
    expect((data['signals'] as unknown[]).length).toBe(1);
    // Always calls getRecent with the authenticated userId
    expect(signalRepository.getRecent).toHaveBeenCalledWith(USER_ID, undefined, expect.any(Number));
  });

  it('returns isError for invalid since timestamp', async () => {
    const result = await subscribeSignals(USER_ID, { since: 'not-a-date' });
    expect(result.isError).toBe(true);
  });
});

// ─── query_memory ─────────────────────────────────────────────────────────────
describe('query_memory', () => {
  it('returns empty results when mempalace returns nothing', async () => {
    const db = await import('@skytwin/db');
    vi.mocked(db.mempalaceRepository.searchDrawers).mockResolvedValueOnce([]);
    vi.mocked(db.mempalaceRepository.searchEpisodes).mockResolvedValueOnce([]);

    const result = await queryMemory(USER_ID, { question: 'what did I work on last week?' });
    const data = parseResult(result) as Record<string, unknown>;
    expect(Array.isArray(data['results'])).toBe(true);
  });

  it('returns isError when question is empty', async () => {
    const result = await queryMemory(USER_ID, { question: '' });
    expect(result.isError).toBe(true);
  });

  it('falls back gracefully when mempalace throws', async () => {
    const db = await import('@skytwin/db');
    vi.mocked(db.mempalaceRepository.searchDrawers).mockRejectedValueOnce(new Error('DB error'));
    vi.mocked(db.mempalaceRepository.searchEpisodes).mockRejectedValueOnce(new Error('DB error'));

    const result = await queryMemory(USER_ID, { question: 'test query' });
    // Should not throw — returns empty with note
    expect(result.isError).toBeFalsy();
    const data = parseResult(result) as Record<string, unknown>;
    expect(Array.isArray(data['results'])).toBe(true);
    expect(data['note']).toBeDefined();
  });
});
