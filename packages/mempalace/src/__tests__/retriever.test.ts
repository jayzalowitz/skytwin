import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRetriever } from '../retriever.js';
import type { MemoryStack } from '../memory-stack.js';
import type { EpisodeStore } from '../episode-store.js';
import type { DecisionContext, DecisionObject, EpisodicMemory, WakeUpContext } from '@skytwin/shared-types';
import { ConfidenceLevel, SituationType, TrustTier } from '@skytwin/shared-types';

function createMockStack(): MemoryStack {
  return {
    wakeUp: vi.fn(async (userId: string): Promise<WakeUpContext> => ({
      userId,
      identity: `User ${userId}: Software engineer, prefers concise emails`,
      essentialStory: 'Key episodes: archived newsletters automatically [good]',
      tokenCount: 25,
      generatedAt: new Date(),
    })),
    search: vi.fn(async () => ({
      drawers: [],
      episodes: [],
      triples: [],
      totalFound: 0,
      searchedAt: new Date(),
    })),
  } as unknown as MemoryStack;
}

function createMockEpisodeStore(): EpisodeStore {
  const episodes: EpisodicMemory[] = [
    {
      id: 'ep_1',
      userId: 'user1',
      situationSummary: 'Newsletter from tech digest arrived',
      domain: 'email',
      situationType: 'email_triage',
      contextSnapshot: {},
      actionTaken: 'Archive the email',
      feedbackType: 'approve',
      signalIds: [],
      drawerIds: [],
      utilityScore: 0.8,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'ep_2',
      userId: 'user1',
      situationSummary: 'Calendar conflict between two meetings',
      domain: 'calendar',
      situationType: 'calendar_conflict',
      contextSnapshot: {},
      actionTaken: 'Decline the lower-priority meeting',
      feedbackType: 'reject',
      signalIds: [],
      drawerIds: [],
      utilityScore: 0.2,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  return {
    findSimilar: vi.fn(async (_userId, domain, _sitType, _kw, limit) => {
      return episodes
        .filter((e) => e.userId === _userId && e.domain === domain)
        .slice(0, limit);
    }),
    getTopEpisodes: vi.fn(async () => episodes.filter((e) => e.utilityScore > 0.5)),
  } as unknown as EpisodeStore;
}

describe('MemoryRetriever', () => {
  let stack: MemoryStack;
  let episodeStore: EpisodeStore;
  let retriever: MemoryRetriever;

  beforeEach(() => {
    stack = createMockStack();
    episodeStore = createMockEpisodeStore();
    retriever = new MemoryRetriever(stack, episodeStore);
  });

  describe('enrichContext', () => {
    it('should add wake-up context and episodic memories to DecisionContext', async () => {
      const decision: DecisionObject = {
        id: 'dec_1',
        situationType: SituationType.EMAIL_TRIAGE,
        domain: 'email',
        urgency: 'low',
        summary: 'New newsletter from tech digest',
        rawData: { subject: 'Weekly Tech Digest' },
        interpretedAt: new Date(),
      };

      const context: DecisionContext = {
        userId: 'user1',
        decision,
        trustTier: TrustTier.LOW_AUTONOMY,
        relevantPreferences: [],
        timestamp: new Date(),
      };

      const enriched = await retriever.enrichContext(context);

      // Should have wake-up context
      expect(enriched.wakeUpContext).toBeDefined();
      expect(enriched.wakeUpContext!.identity).toContain('user1');
      expect(enriched.wakeUpContext!.tokenCount).toBeGreaterThan(0);

      // Should have episodic memories
      expect(enriched.episodicMemories).toBeDefined();
      expect(enriched.episodicMemories!.length).toBeGreaterThan(0);
      expect(enriched.episodicMemories![0]!.domain).toBe('email');
    });

    it('should preserve existing context fields', async () => {
      const decision: DecisionObject = {
        id: 'dec_2',
        situationType: SituationType.CALENDAR_CONFLICT,
        domain: 'calendar',
        urgency: 'high',
        summary: 'Two meetings overlap',
        rawData: {},
        interpretedAt: new Date(),
      };

      const context: DecisionContext = {
        userId: 'user1',
        decision,
        trustTier: TrustTier.MODERATE_AUTONOMY,
        relevantPreferences: [
          {
            id: 'pref_1',
            domain: 'calendar',
            key: 'auto_decline',
            value: true,
            confidence: ConfidenceLevel.HIGH,
            source: 'explicit',
            evidenceIds: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        timestamp: new Date(),
      };

      const enriched = await retriever.enrichContext(context);

      expect(enriched.trustTier).toBe(TrustTier.MODERATE_AUTONOMY);
      expect(enriched.relevantPreferences.length).toBe(1);
      expect(enriched.userId).toBe('user1');
    });
  });

  describe('findRelevantEpisodes', () => {
    it('should find episodes matching domain', async () => {
      const decision: DecisionObject = {
        id: 'dec_1',
        situationType: SituationType.EMAIL_TRIAGE,
        domain: 'email',
        urgency: 'low',
        summary: 'New email',
        rawData: {},
        interpretedAt: new Date(),
      };

      const episodes = await retriever.findRelevantEpisodes('user1', decision);
      expect(episodes.length).toBeGreaterThan(0);
      expect(episodes.every((e) => e.domain === 'email')).toBe(true);
    });
  });

  describe('scoreEpisodeRelevance', () => {
    it('should score same-domain episodes higher', () => {
      const decision: DecisionObject = {
        id: 'dec_1',
        situationType: SituationType.EMAIL_TRIAGE,
        domain: 'email',
        urgency: 'low',
        summary: 'test',
        rawData: {},
        interpretedAt: new Date(),
      };

      const episodes: EpisodicMemory[] = [
        {
          id: 'ep_email',
          userId: 'user1',
          situationSummary: 'Email episode',
          domain: 'email',
          situationType: 'email_triage',
          contextSnapshot: {},
          signalIds: [],
          drawerIds: [],
          utilityScore: 0.8,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'ep_calendar',
          userId: 'user1',
          situationSummary: 'Calendar episode',
          domain: 'calendar',
          situationType: 'calendar_conflict',
          contextSnapshot: {},
          signalIds: [],
          drawerIds: [],
          utilityScore: 0.8,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const scored = retriever.scoreEpisodeRelevance(episodes, decision);
      expect(scored[0]!.episode.domain).toBe('email');
      expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
    });
  });
});
