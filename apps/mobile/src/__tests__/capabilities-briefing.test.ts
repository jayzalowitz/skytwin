import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for CapabilitiesScreen, BriefingScreen, and the API client
 * extensions added in #179 (partial).
 *
 * React Native / Expo modules are not available in a plain Node/vitest
 * environment, so these tests validate the pure logic layers:
 *  - API client method URL construction and response shaping
 *  - Screen state logic (loading, empty state, populated state) modelled as
 *    plain functions extracted from the render flow
 */

// ────────────────────────────────────────────────
// Mock fetch
// ────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ────────────────────────────────────────────────
// Inline test client mirroring the real SkyTwinApiClient
// (avoids React Native import resolution issues in Node/vitest)
// ────────────────────────────────────────────────

interface CapabilitySkill {
  name: string;
  description: string;
  riskLevel: string;
}

interface InstalledCapability {
  id: string;
  name: string;
  status: string;
  lastActiveAt: string | null;
  zeroTrustMode: boolean;
  spendCapMonthlyUsd: number | null;
  skills: CapabilitySkill[];
}

interface CapabilitySuggestion {
  id: string;
  registryId: string;
  name: string;
  reason: string;
  category: string;
}

interface CapabilitiesPayload {
  installed: InstalledCapability[];
  suggestions: CapabilitySuggestion[];
  dormant: InstalledCapability[];
}

interface CapabilityDetail {
  id: string;
  name: string;
  status: string;
  lastActiveAt: string | null;
  zeroTrustMode: boolean;
  spendCapMonthlyUsd: number | null;
  spendUsedMonthUsd: number | null;
  skills: CapabilitySkill[];
  provenanceUrl: string | null;
}

interface TwinBriefing {
  id: string;
  cadence: 'daily' | 'weekly';
  headline: string;
  keySignals: string[];
  pendingApprovalsCount: number;
  generatedAt: string;
  readAt: string | null;
  proseMarkdown: string;
  actionOpportunities?: BriefingActionOpportunity[];
}

interface BriefingActionOpportunity {
  label: string;
  reason: string;
  suggestedAction: string;
  actionType: string;
  primaryAdapter: string;
  readiness: string;
  runtimeVersion?: {
    displayName?: string;
    stableVersion?: string;
    prereleaseVersion?: string;
  };
}

interface TwinBriefingPayload {
  briefing: TwinBriefing | null;
  unreadCount: number;
}

type ApiResult<T> = { success: true; data: T } | { success: false; error: string; statusCode?: number };

class TestApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token: string, timeoutMs = 10_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async fetchCapabilities(userId: string): Promise<ApiResult<CapabilitiesPayload>> {
    return this.get<CapabilitiesPayload>(
      `/api/capabilities/${encodeURIComponent(userId)}`,
    );
  }

  async fetchCapabilityDetail(
    userId: string,
    serverId: string,
  ): Promise<ApiResult<CapabilityDetail>> {
    return this.get<CapabilityDetail>(
      `/api/capabilities/${encodeURIComponent(userId)}/${encodeURIComponent(serverId)}`,
    );
  }

  async fetchTwinBriefing(userId: string): Promise<ApiResult<TwinBriefingPayload>> {
    const query = new URLSearchParams({ cadence: 'daily', userId });
    const result = await this.get<Record<string, unknown>>(
      `/api/twin-briefings/latest?${query.toString()}`,
    );
    if (!result.success) return result;
    const raw = result.data['briefing'] as Record<string, unknown> | null | undefined;
    if (!raw) return { success: true, data: { briefing: null, unreadCount: Number(result.data['unreadCount'] ?? 0) } };
    const structured = raw['structured'] as Record<string, unknown> | null | undefined;
    const memory = (structured?.['memorySuggestions'] as Array<Record<string, unknown>> | undefined) ?? [];
    const todos = (structured?.['todos'] as unknown[] | undefined) ?? [];
    const prose = String(raw['proseMarkdown'] ?? raw['prose_markdown'] ?? '');
    const readAt = (raw['readAt'] ?? raw['read_at'] ?? null) as string | null;
    const actionOpportunities = memory.map((s) => {
      const plan = (s['actionPlan'] as Record<string, unknown> | undefined) ?? {};
      return {
        label: String(plan['label'] ?? s['title'] ?? 'Act on memory'),
        reason: String(s['reason'] ?? ''),
        suggestedAction: String(s['suggestedAction'] ?? ''),
        actionType: String(plan['actionType'] ?? ''),
        primaryAdapter: String(plan['primaryAdapter'] ?? ''),
        readiness: String(plan['readiness'] ?? ''),
        runtimeVersion: plan['runtimeVersion'] as BriefingActionOpportunity['runtimeVersion'],
      };
    });
    const firstLine = prose.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean);
    const rawLines = prose
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const keySignals = rawLines
      .filter((line, index) => index !== 0 || !line.startsWith('#'))
      .map((line) => line.replace(/^[-*]\s*/, '').replace(/^#+\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 3);
    return {
      success: true,
      data: {
        briefing: {
          id: String(raw['id'] ?? 'latest'),
          cadence: raw['cadence'] === 'weekly' ? 'weekly' : 'daily',
          headline: String(raw['headline'] ?? firstLine ?? 'Your latest briefing'),
          keySignals,
          pendingApprovalsCount: Number(raw['pendingApprovalsCount'] ?? todos.length),
          generatedAt: String(raw['generatedAt'] ?? raw['generated_at'] ?? new Date().toISOString()),
          readAt,
          proseMarkdown: prose,
          actionOpportunities,
        },
        unreadCount: Number(result.data['unreadCount'] ?? (readAt === null ? 1 : 0)),
      },
    };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private async get<T>(path: string): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const errorMsg =
          typeof data === 'object' && data !== null && 'error' in data
            ? String((data as Record<string, unknown>)['error'])
            : `HTTP ${response.status}`;
        return { success: false, error: errorMsg, statusCode: response.status };
      }
      return { success: true, data: data as T };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { success: false, error: 'Request timed out' };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ────────────────────────────────────────────────
// API client — capabilities call shape
// ────────────────────────────────────────────────

describe('API client fetchCapabilities', () => {
  let client: TestApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new TestApiClient('http://192.168.1.50:3100', 'sess-token');
  });

  it('calls the correct capabilities endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ installed: [], suggestions: [], dormant: [] }),
    });
    await client.fetchCapabilities('user-1');
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toBe('http://192.168.1.50:3100/api/capabilities/user-1');
  });

  it('encodes userId with special characters', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ installed: [], suggestions: [], dormant: [] }),
    });
    await client.fetchCapabilities('user@example.com');
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toContain('user%40example.com');
    expect(url).not.toContain('@');
  });

  it('returns installed list on success', async () => {
    const installed: InstalledCapability[] = [
      {
        id: 'cap-1',
        name: 'Calendar Assistant',
        status: 'running',
        lastActiveAt: '2026-05-08T10:00:00Z',
        zeroTrustMode: false,
        spendCapMonthlyUsd: null,
        skills: [{ name: 'create_event', description: 'Creates calendar events', riskLevel: 'low' }],
      },
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ installed, suggestions: [], dormant: [] }),
    });
    const result = await client.fetchCapabilities('u1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.installed).toHaveLength(1);
      expect(result.data.installed[0]?.name).toBe('Calendar Assistant');
      expect(result.data.suggestions).toHaveLength(0);
    }
  });

  it('returns suggestions when present', async () => {
    const suggestions: CapabilitySuggestion[] = [
      { id: 'sug-1', registryId: 'reg-a', name: 'GitHub', reason: 'You use Git frequently', category: 'developer' },
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ installed: [], suggestions, dormant: [] }),
    });
    const result = await client.fetchCapabilities('u1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.suggestions).toHaveLength(1);
      expect(result.data.suggestions[0]?.name).toBe('GitHub');
    }
  });

  it('returns error result on 404', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'User not found' }),
    });
    const result = await client.fetchCapabilities('no-such-user');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('User not found');
      expect(result.statusCode).toBe(404);
    }
  });

  it('calls capability detail endpoint with correct path', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'cap-1',
        name: 'Github',
        status: 'running',
        lastActiveAt: null,
        zeroTrustMode: true,
        spendCapMonthlyUsd: 10.0,
        spendUsedMonthUsd: 3.5,
        skills: [],
        provenanceUrl: null,
      }),
    });
    await client.fetchCapabilityDetail('user-1', 'cap-1');
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toBe('http://192.168.1.50:3100/api/capabilities/user-1/cap-1');
  });
});

// ────────────────────────────────────────────────
// API client — briefing call shape
// ────────────────────────────────────────────────

describe('API client fetchTwinBriefing', () => {
  let client: TestApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new TestApiClient('http://192.168.1.50:3100', 'sess-token');
  });

  it('calls the correct briefing endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ briefing: null, unreadCount: 0 }),
    });
    await client.fetchTwinBriefing('user-1');
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toBe('http://192.168.1.50:3100/api/twin-briefings/latest?cadence=daily&userId=user-1');
  });

  it('encodes userId in briefing endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ briefing: null, unreadCount: 0 }),
    });
    await client.fetchTwinBriefing('user@domain.io');
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toContain('user%40domain.io');
  });

  it('returns briefing payload on success', async () => {
    const briefing = {
      id: 'br-1',
      cadence: 'daily',
      generated_at: '2026-05-08T08:00:00Z',
      read_at: null,
      prose_markdown: '## Three meetings and a long email thread\n\n- Calendar conflict at 2pm\n- Unread thread from Alice',
      structured: {
        todos: [{ ref: 'todo-1' }, { ref: 'todo-2' }],
        topics: [],
        memorySuggestions: [
          {
            title: 'Memory link',
            reason: 'Maria asked about the security review.',
            suggestedAction: 'Try draft a reply through IronClaw (draft_email).',
            actionPlan: {
              label: 'draft a reply using this memory',
              actionType: 'draft_email',
              primaryAdapter: 'ironclaw',
              readiness: 'known_action_type',
              runtimeVersion: {
                displayName: 'IronClaw',
                stableVersion: '0.29.1',
              },
            },
          },
        ],
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ briefing }),
    });
    const result = await client.fetchTwinBriefing('u1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.briefing).not.toBeNull();
      expect(result.data.briefing?.headline).toBe('Three meetings and a long email thread');
      expect(result.data.briefing?.keySignals).toHaveLength(2);
      expect(result.data.briefing?.pendingApprovalsCount).toBe(2);
      expect(result.data.briefing?.actionOpportunities?.[0]).toMatchObject({
        actionType: 'draft_email',
        primaryAdapter: 'ironclaw',
        runtimeVersion: {
          stableVersion: '0.29.1',
        },
      });
      expect(result.data.unreadCount).toBe(1);
    }
  });

  it('handles null briefing (no briefing generated yet)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ briefing: null, unreadCount: 0 }),
    });
    const result = await client.fetchTwinBriefing('u1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.briefing).toBeNull();
      expect(result.data.unreadCount).toBe(0);
    }
  });

  it('returns error result on 500', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal server error' }),
    });
    const result = await client.fetchTwinBriefing('u1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(500);
    }
  });
});

// ────────────────────────────────────────────────
// CapabilitiesScreen — list rendering logic
// ────────────────────────────────────────────────

describe('CapabilitiesScreen state logic', () => {
  // Model the state machine that the component drives:
  // given raw API data, what does the screen display?

  interface ScreenState {
    loading: boolean;
    installed: InstalledCapability[];
    suggestions: CapabilitySuggestion[];
    dormant: InstalledCapability[];
    error: string | null;
  }

  function buildState(overrides: Partial<ScreenState> = {}): ScreenState {
    return {
      loading: false,
      installed: [],
      suggestions: [],
      dormant: [],
      error: null,
      ...overrides,
    };
  }

  function isEmptyInstalled(state: ScreenState): boolean {
    return !state.loading && state.installed.length === 0 && state.error === null;
  }

  function hasInstalledList(state: ScreenState): boolean {
    return !state.loading && state.installed.length > 0;
  }

  function hasSuggestions(state: ScreenState): boolean {
    return state.suggestions.length > 0;
  }

  it('renders empty state when installed list is empty', () => {
    const state = buildState({ installed: [] });
    expect(isEmptyInstalled(state)).toBe(true);
    expect(hasInstalledList(state)).toBe(false);
  });

  it('renders installed list when capabilities present', () => {
    const state = buildState({
      installed: [
        {
          id: 'cap-1',
          name: 'GitHub',
          status: 'running',
          lastActiveAt: null,
          zeroTrustMode: false,
          spendCapMonthlyUsd: null,
          skills: [],
        },
        {
          id: 'cap-2',
          name: 'Slack',
          status: 'stopped',
          lastActiveAt: '2026-05-07T12:00:00Z',
          zeroTrustMode: true,
          spendCapMonthlyUsd: 5,
          skills: [],
        },
      ],
    });
    expect(hasInstalledList(state)).toBe(true);
    expect(isEmptyInstalled(state)).toBe(false);
    expect(state.installed).toHaveLength(2);
  });

  it('shows suggestions section only when suggestions exist', () => {
    const emptyState = buildState({ suggestions: [] });
    const withSuggestions = buildState({
      suggestions: [
        { id: 's1', registryId: 'r1', name: 'Jira', reason: 'You manage tickets', category: 'developer' },
      ],
    });
    expect(hasSuggestions(emptyState)).toBe(false);
    expect(hasSuggestions(withSuggestions)).toBe(true);
  });

  it('dismissing a suggestion removes it from the list', () => {
    let state = buildState({
      suggestions: [
        { id: 's1', registryId: 'r1', name: 'Jira', reason: 'Reason', category: 'developer' },
        { id: 's2', registryId: 'r2', name: 'Linear', reason: 'Reason', category: 'developer' },
      ],
    });
    // Simulate dismiss handler
    state = { ...state, suggestions: state.suggestions.filter((s) => s.id !== 's1') };
    expect(state.suggestions).toHaveLength(1);
    expect(state.suggestions[0]?.id).toBe('s2');
  });

  it('shows error when API returns error', () => {
    const state = buildState({ error: 'Network error: SkyTwin not reachable' });
    expect(state.error).not.toBeNull();
    expect(isEmptyInstalled(state)).toBe(false); // Error hides empty-state
  });

  it('loading state prevents list render', () => {
    const state = buildState({ loading: true });
    expect(isEmptyInstalled(state)).toBe(false);
    expect(hasInstalledList(state)).toBe(false);
  });
});

// ────────────────────────────────────────────────
// BriefingScreen — rendering logic
// ────────────────────────────────────────────────

describe('BriefingScreen state logic', () => {
  interface BriefingScreenState {
    loading: boolean;
    briefing: TwinBriefing | null;
    unreadCount: number;
    error: string | null;
  }

  function buildBriefingState(overrides: Partial<BriefingScreenState> = {}): BriefingScreenState {
    return {
      loading: false,
      briefing: null,
      unreadCount: 0,
      error: null,
      ...overrides,
    };
  }

  function shouldShowEmpty(state: BriefingScreenState): boolean {
    return !state.loading && state.briefing === null && state.error === null;
  }

  function shouldShowBriefing(state: BriefingScreenState): boolean {
    return !state.loading && state.briefing !== null;
  }

  function shouldShowUnreadBadge(state: BriefingScreenState): boolean {
    return state.unreadCount > 0;
  }

  function shouldShowApprovalsPrompt(state: BriefingScreenState): boolean {
    return (state.briefing?.pendingApprovalsCount ?? 0) > 0;
  }

  it('shows empty state when no briefing generated yet', () => {
    const state = buildBriefingState({ briefing: null });
    expect(shouldShowEmpty(state)).toBe(true);
    expect(shouldShowBriefing(state)).toBe(false);
  });

  it('shows briefing content when briefing is present', () => {
    const briefing: TwinBriefing = {
      id: 'br-1',
      cadence: 'daily',
      headline: 'A productive day ahead',
      keySignals: ['Meeting at 2pm', 'Invoice due tomorrow'],
      pendingApprovalsCount: 0,
      generatedAt: '2026-05-08T08:00:00Z',
      readAt: null,
      proseMarkdown: '',
    };
    const state = buildBriefingState({ briefing });
    expect(shouldShowBriefing(state)).toBe(true);
    expect(shouldShowEmpty(state)).toBe(false);
  });

  it('shows loading state during fetch', () => {
    const state = buildBriefingState({ loading: true });
    expect(shouldShowEmpty(state)).toBe(false);
    expect(shouldShowBriefing(state)).toBe(false);
  });

  it('shows unread badge when unreadCount > 0', () => {
    const state = buildBriefingState({ unreadCount: 3 });
    expect(shouldShowUnreadBadge(state)).toBe(true);
    const zeroState = buildBriefingState({ unreadCount: 0 });
    expect(shouldShowUnreadBadge(zeroState)).toBe(false);
  });

  it('shows approvals prompt when pendingApprovalsCount > 0', () => {
    const briefing: TwinBriefing = {
      id: 'br-2',
      cadence: 'daily',
      headline: 'Busy day',
      keySignals: [],
      pendingApprovalsCount: 4,
      generatedAt: '2026-05-08T08:00:00Z',
      readAt: null,
      proseMarkdown: '',
    };
    const state = buildBriefingState({ briefing });
    expect(shouldShowApprovalsPrompt(state)).toBe(true);
  });

  it('hides approvals prompt when zero pending', () => {
    const briefing: TwinBriefing = {
      id: 'br-3',
      cadence: 'daily',
      headline: 'All caught up',
      keySignals: [],
      pendingApprovalsCount: 0,
      generatedAt: '2026-05-08T08:00:00Z',
      readAt: null,
      proseMarkdown: '',
    };
    const state = buildBriefingState({ briefing });
    expect(shouldShowApprovalsPrompt(state)).toBe(false);
  });
});

// ────────────────────────────────────────────────
// Relative time formatting
// ────────────────────────────────────────────────

describe('relative time formatting', () => {
  function formatRelativeTime(isoString: string, nowIso: string): string {
    const date = new Date(isoString);
    const now = new Date(nowIso);
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60_000);
    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  const NOW = '2026-05-08T12:00:00Z';

  it('shows "just now" for times under a minute ago', () => {
    expect(formatRelativeTime('2026-05-08T11:59:30Z', NOW)).toBe('just now');
  });

  it('shows minutes for times under an hour', () => {
    expect(formatRelativeTime('2026-05-08T11:45:00Z', NOW)).toBe('15m ago');
  });

  it('shows hours for times under a day', () => {
    expect(formatRelativeTime('2026-05-08T08:00:00Z', NOW)).toBe('4h ago');
  });

  it('shows days for times under a week', () => {
    expect(formatRelativeTime('2026-05-05T12:00:00Z', NOW)).toBe('3d ago');
  });

  it('shows locale date for times over a week ago', () => {
    const result = formatRelativeTime('2026-04-01T12:00:00Z', NOW);
    // Just check it's not one of the relative formats
    expect(result).not.toContain('ago');
    expect(result).not.toBe('just now');
  });
});

// ────────────────────────────────────────────────
// Spend meter percentage calculation
// ────────────────────────────────────────────────

describe('spend meter percentage calculation', () => {
  function spendPercent(used: number, cap: number): number {
    return cap > 0 ? Math.min(used / cap, 1) : 0;
  }

  it('returns 0 when nothing used', () => {
    expect(spendPercent(0, 10)).toBe(0);
  });

  it('returns 0.5 at half cap', () => {
    expect(spendPercent(5, 10)).toBe(0.5);
  });

  it('caps at 1.0 when over cap', () => {
    expect(spendPercent(15, 10)).toBe(1);
  });

  it('returns 0 when cap is 0 (avoid division by zero)', () => {
    expect(spendPercent(5, 0)).toBe(0);
  });
});

// ────────────────────────────────────────────────
// Capability status badge color
// ────────────────────────────────────────────────

describe('capability status badge colors', () => {
  const STATUS_COLORS: Record<string, string> = {
    running: '#2ecc71',
    stopped: '#f39c12',
    error: '#e74c3c',
    dormant: '#888',
  };

  it('running is green', () => {
    expect(STATUS_COLORS['running']).toBe('#2ecc71');
  });

  it('stopped is orange', () => {
    expect(STATUS_COLORS['stopped']).toBe('#f39c12');
  });

  it('error is red', () => {
    expect(STATUS_COLORS['error']).toBe('#e74c3c');
  });

  it('unknown status falls back to grey', () => {
    const color = STATUS_COLORS['unknown'] ?? '#888';
    expect(color).toBe('#888');
  });
});
