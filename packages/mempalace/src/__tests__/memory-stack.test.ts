import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryStack, type ClosetRepositoryPort, type TripleSearchPort } from '../memory-stack.js';
import type { PalaceRepositoryPort } from '../palace.js';
import type { EpisodeRepositoryPort } from '../episode-store.js';
import type {
  MemoryWing,
  MemoryDrawer,
  MemoryCloset,
  KnowledgeTriple,
  EpisodicMemory,
  DrawerMetadata,
} from '@skytwin/shared-types';
import { ConfidenceLevel, MemoryLayer } from '@skytwin/shared-types';

// ── Helpers ────────────────────────────────────────────────────────

function makeWing(overrides: Partial<MemoryWing> = {}): MemoryWing {
  return {
    id: 'wing_comm',
    userId: 'user1',
    name: 'communication',
    description: 'Communication wing',
    domains: ['email'],
    drawerCount: 2,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDrawer(overrides: Partial<MemoryDrawer> = {}): MemoryDrawer {
  return {
    id: 'drawer_1',
    roomId: 'room_1',
    wingId: 'wing_comm',
    userId: 'user1',
    hall: 'facts',
    content: 'Alice prefers morning meetings',
    metadata: { importance: 0.8, domain: 'email' } as DrawerMetadata,
    sourceType: 'signal',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<EpisodicMemory> = {}): EpisodicMemory {
  return {
    id: 'ep_1',
    userId: 'user1',
    situationSummary: 'Newsletter from tech digest arrived',
    domain: 'email',
    situationType: 'email_triage',
    contextSnapshot: { timeOfDay: 'morning', dayOfWeek: 1 },
    actionTaken: 'Archived automatically',
    feedbackType: 'approve',
    utilityScore: 0.8,
    signalIds: [],
    drawerIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTriple(overrides: Partial<KnowledgeTriple> = {}): KnowledgeTriple {
  return {
    id: 'triple_1',
    userId: 'user1',
    subject: 'Jay',
    predicate: 'is',
    object: 'a software engineer',
    validFrom: new Date(),
    validTo: null,
    confidence: ConfidenceLevel.HIGH,
    extractedAt: new Date(),
    ...overrides,
  };
}

function makeCloset(overrides: Partial<MemoryCloset> = {}): MemoryCloset {
  return {
    id: 'closet_1',
    roomId: 'room_1',
    wingId: 'wing_comm',
    userId: 'user1',
    compressedContent: 'ALC prefers AM mtgs | BOB ships Fridays',
    sourceDrawerIds: ['drawer_1', 'drawer_2'],
    drawerCount: 2,
    tokenCount: 30,
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Mock factories ─────────────────────────────────────────────────

function createMockPalaceRepo(
  wings: MemoryWing[] = [],
  drawers: MemoryDrawer[] = [],
): PalaceRepositoryPort {
  return {
    createWing: vi.fn(),
    getWings: vi.fn(async () => wings),
    getWingByName: vi.fn(),
    createRoom: vi.fn(),
    getRooms: vi.fn(),
    getRoomByName: vi.fn(),
    getRoomsByTopic: vi.fn(),
    createDrawer: vi.fn(),
    getDrawers: vi.fn(async (_userId, _opts) => drawers),
    searchDrawers: vi.fn(async (_userId, terms, _limit) =>
      drawers.filter((d) => terms.some((t: string) => d.content.toLowerCase().includes(t.toLowerCase()))),
    ),
    findDrawerBySourceId: vi.fn(async () => null),
    deleteDrawer: vi.fn(),
    upsertTunnel: vi.fn(),
    getTunnels: vi.fn(),
    getStatus: vi.fn(),
  };
}

function createMockEpisodeRepo(episodes: EpisodicMemory[] = []): EpisodeRepositoryPort {
  return {
    createEpisode: vi.fn(),
    getEpisodes: vi.fn(async (_userId, opts) => {
      let result = episodes;
      if (opts?.domain) result = result.filter((e) => e.domain === opts.domain);
      if (opts?.minUtility) result = result.filter((e) => e.utilityScore >= opts.minUtility!);
      if (opts?.limit) result = result.slice(0, opts.limit);
      return result;
    }),
    getEpisodeByDecision: vi.fn(),
    updateEpisode: vi.fn(),
    searchEpisodes: vi.fn(async (_userId, terms, limit) =>
      episodes
        .filter((e) => terms.some((t: string) => e.situationSummary.toLowerCase().includes(t.toLowerCase())))
        .slice(0, limit ?? 10),
    ),
  };
}

function createMockClosetRepo(closets: MemoryCloset[] = []): ClosetRepositoryPort {
  return {
    getClosets: vi.fn(async () => closets),
    createCloset: vi.fn(),
  };
}

function createMockTripleSearch(triples: KnowledgeTriple[] = []): TripleSearchPort {
  return {
    queryTriples: vi.fn(async (_userId, opts) => {
      let result = triples;
      if (opts?.predicate) result = result.filter((t) => t.predicate === opts.predicate);
      if (opts?.subject) result = result.filter((t) =>
        t.subject.toLowerCase().includes(opts.subject!.toLowerCase()),
      );
      if (opts?.limit) result = result.slice(0, opts.limit);
      return result;
    }),
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('MemoryStack', () => {
  describe('wakeUp (L0 + L1)', () => {
    it('should return identity from core triples and essential story from top drawers', async () => {
      const triples = [
        makeTriple({ subject: 'Jay', predicate: 'is', object: 'a software engineer' }),
        makeTriple({ id: 't2', subject: 'Jay', predicate: 'is', object: 'based in SF' }),
      ];
      const drawers = [
        makeDrawer({ content: 'Prefers dark mode', metadata: { importance: 0.9, domain: 'general' } as DrawerMetadata }),
        makeDrawer({ id: 'd2', content: 'Uses vim', metadata: { importance: 0.3, domain: 'general' } as DrawerMetadata }),
      ];
      const episodes = [makeEpisode()];

      const stack = new MemoryStack(
        createMockPalaceRepo([], drawers),
        createMockEpisodeRepo(episodes),
        createMockClosetRepo(),
        createMockTripleSearch(triples),
      );

      const ctx = await stack.wakeUp('user1');

      expect(ctx.userId).toBe('user1');
      expect(ctx.identity).toContain('Jay');
      expect(ctx.identity).toContain('software engineer');
      expect(ctx.identity).toContain('SF');
      expect(ctx.essentialStory).toContain('Prefers dark mode');
      expect(ctx.tokenCount).toBeGreaterThan(0);
      expect(ctx.generatedAt).toBeInstanceOf(Date);
    });

    it('should return fallback identity when no triples exist', async () => {
      const stack = new MemoryStack(
        createMockPalaceRepo(),
        createMockEpisodeRepo(),
        createMockClosetRepo(),
        createMockTripleSearch([]),
      );

      const ctx = await stack.wakeUp('user1');

      expect(ctx.identity).toContain('No identity context established yet');
    });

    it('should return fallback essential story when no drawers or episodes exist', async () => {
      const stack = new MemoryStack(
        createMockPalaceRepo([], []),
        createMockEpisodeRepo([]),
        createMockClosetRepo(),
        createMockTripleSearch([makeTriple()]),
      );

      const ctx = await stack.wakeUp('user1');

      expect(ctx.essentialStory).toContain('No essential context available yet');
    });

    it('should include episode summaries with feedback labels in L1', async () => {
      const episodes = [
        makeEpisode({ feedbackType: 'approve', situationSummary: 'Archive newsletters', actionTaken: 'Auto-archived', utilityScore: 0.9 }),
        makeEpisode({ id: 'ep_2', feedbackType: 'reject', situationSummary: 'Delete important email', actionTaken: 'Deleted', utilityScore: 0.7 }),
      ];

      const stack = new MemoryStack(
        createMockPalaceRepo([], [makeDrawer()]),
        createMockEpisodeRepo(episodes),
        createMockClosetRepo(),
        createMockTripleSearch([makeTriple()]),
      );

      const ctx = await stack.wakeUp('user1');

      expect(ctx.essentialStory).toContain('[good]');
      expect(ctx.essentialStory).toContain('[bad]');
      expect(ctx.essentialStory).toContain('Archive newsletters');
    });

    it('should sort drawers by importance and take top 5', async () => {
      const drawers = Array.from({ length: 10 }, (_, i) =>
        makeDrawer({
          id: `d_${i}`,
          content: `Memory ${i}`,
          metadata: { importance: i * 0.1, domain: 'general' } as DrawerMetadata,
        }),
      );

      const stack = new MemoryStack(
        createMockPalaceRepo([], drawers),
        createMockEpisodeRepo(),
        createMockClosetRepo(),
        createMockTripleSearch([makeTriple()]),
      );

      const ctx = await stack.wakeUp('user1');

      // Should contain the highest-importance drawer (Memory 9) but not the lowest (Memory 0)
      expect(ctx.essentialStory).toContain('Memory 9');
      expect(ctx.essentialStory).toContain('Memory 8');
      expect(ctx.essentialStory).not.toContain('Memory 0');
    });
  });

  describe('recall (L2)', () => {
    it('should return closets, recent drawers, and episodes for a wing', async () => {
      const wings = [makeWing({ id: 'wing_comm', name: 'communication', domains: ['email'] })];
      const drawers = [makeDrawer({ wingId: 'wing_comm' })];
      const closets = [makeCloset({ wingId: 'wing_comm' })];
      const episodes = [makeEpisode({ domain: 'email' })];

      const stack = new MemoryStack(
        createMockPalaceRepo(wings, drawers),
        createMockEpisodeRepo(episodes),
        createMockClosetRepo(closets),
        createMockTripleSearch(),
      );

      const result = await stack.recall('user1', 'communication');

      expect(result.wingName).toBe('communication');
      expect(result.closets).toHaveLength(1);
      expect(result.recentDrawers).toHaveLength(1);
      expect(result.relevantEpisodes).toHaveLength(1);
      expect(result.tokenCount).toBeGreaterThan(0);
    });

    it('should return empty result for unknown wing', async () => {
      const stack = new MemoryStack(
        createMockPalaceRepo([], []),
        createMockEpisodeRepo(),
        createMockClosetRepo(),
        createMockTripleSearch(),
      );

      const result = await stack.recall('user1', 'nonexistent');

      expect(result.wingName).toBe('nonexistent');
      expect(result.closets).toHaveLength(0);
      expect(result.recentDrawers).toHaveLength(0);
      expect(result.relevantEpisodes).toHaveLength(0);
      expect(result.tokenCount).toBe(0);
    });

    it('should filter closets to the matching wing', async () => {
      const wings = [makeWing({ id: 'wing_comm', name: 'communication' })];
      const closets = [
        makeCloset({ wingId: 'wing_comm' }),
        makeCloset({ id: 'closet_other', wingId: 'wing_finance' }),
      ];

      const stack = new MemoryStack(
        createMockPalaceRepo(wings, []),
        createMockEpisodeRepo(),
        createMockClosetRepo(closets),
        createMockTripleSearch(),
      );

      const result = await stack.recall('user1', 'communication');

      expect(result.closets).toHaveLength(1);
      expect(result.closets[0]!.id).toBe('closet_1');
    });
  });

  describe('search (L3)', () => {
    it('should search drawers, episodes, and triples in parallel', async () => {
      const drawers = [makeDrawer({ content: 'Alice meeting notes' })];
      const episodes = [makeEpisode({ situationSummary: 'Meeting with Alice' })];
      const triples = [makeTriple({ subject: 'Alice', predicate: 'works_at', object: 'Acme' })];

      const stack = new MemoryStack(
        createMockPalaceRepo([], drawers),
        createMockEpisodeRepo(episodes),
        createMockClosetRepo(),
        createMockTripleSearch(triples),
      );

      const result = await stack.search('user1', ['Alice']);

      expect(result.drawers).toHaveLength(1);
      expect(result.episodes).toHaveLength(1);
      expect(result.triples).toHaveLength(1);
      expect(result.totalFound).toBe(3);
      expect(result.searchedAt).toBeInstanceOf(Date);
    });

    it('should return empty results when nothing matches', async () => {
      const stack = new MemoryStack(
        createMockPalaceRepo(),
        createMockEpisodeRepo(),
        createMockClosetRepo(),
        createMockTripleSearch(),
      );

      const result = await stack.search('user1', ['nonexistent']);

      expect(result.totalFound).toBe(0);
    });

    it('should deduplicate triple results across multiple search terms', async () => {
      const triple = makeTriple({ subject: 'Alice Bob' });

      const stack = new MemoryStack(
        createMockPalaceRepo(),
        createMockEpisodeRepo(),
        createMockClosetRepo(),
        createMockTripleSearch([triple]),
      );

      const result = await stack.search('user1', ['Alice', 'Bob']);

      // Same triple matched by both terms should appear only once
      expect(result.triples).toHaveLength(1);
    });

    it('should respect the limit parameter', async () => {
      const palaceRepo = createMockPalaceRepo();
      const stack = new MemoryStack(
        palaceRepo,
        createMockEpisodeRepo(),
        createMockClosetRepo(),
        createMockTripleSearch(),
      );

      await stack.search('user1', ['test'], 5);

      expect(palaceRepo.searchDrawers).toHaveBeenCalledWith('user1', ['test'], 5);
    });
  });

  describe('getLayerForContext', () => {
    let stack: MemoryStack;

    beforeEach(() => {
      stack = new MemoryStack(
        createMockPalaceRepo(),
        createMockEpisodeRepo(),
        createMockClosetRepo(),
        createMockTripleSearch(),
      );
    });

    it('should return L3 for deep search', () => {
      expect(stack.getLayerForContext(true, true)).toBe(MemoryLayer.L3_DEEP_SEARCH);
      expect(stack.getLayerForContext(false, true)).toBe(MemoryLayer.L3_DEEP_SEARCH);
    });

    it('should return L2 for specific topic without deep search', () => {
      expect(stack.getLayerForContext(true, false)).toBe(MemoryLayer.L2_ON_DEMAND);
    });

    it('should return L1 for general context', () => {
      expect(stack.getLayerForContext(false, false)).toBe(MemoryLayer.L1_ESSENTIAL);
    });
  });

  describe('token estimation', () => {
    it('should estimate tokens for wake-up context', async () => {
      const triples = [makeTriple({ subject: 'Jay', predicate: 'is', object: 'engineer' })];
      const drawers = [makeDrawer({ content: 'A'.repeat(400) })]; // ~100 tokens

      const stack = new MemoryStack(
        createMockPalaceRepo([], drawers),
        createMockEpisodeRepo(),
        createMockClosetRepo(),
        createMockTripleSearch(triples),
      );

      const ctx = await stack.wakeUp('user1');

      // Token count should be roughly identity + essential story length / 4
      expect(ctx.tokenCount).toBeGreaterThan(0);
      // 400-char drawer content = ~100 tokens, plus identity text
      expect(ctx.tokenCount).toBeGreaterThanOrEqual(100);
    });

    it('should sum closet token counts for recall', async () => {
      const wings = [makeWing()];
      const closets = [
        makeCloset({ wingId: 'wing_comm', tokenCount: 50 }),
        makeCloset({ id: 'c2', wingId: 'wing_comm', tokenCount: 75 }),
      ];

      const stack = new MemoryStack(
        createMockPalaceRepo(wings, []),
        createMockEpisodeRepo(),
        createMockClosetRepo(closets),
        createMockTripleSearch(),
      );

      const result = await stack.recall('user1', 'communication');

      // Token count includes closet tokens (50+75=125) plus drawer/episode text tokens
      expect(result.tokenCount).toBeGreaterThanOrEqual(125);
    });
  });
});
