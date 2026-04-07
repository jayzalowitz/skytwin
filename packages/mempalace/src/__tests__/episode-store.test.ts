import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EpisodeStore, type EpisodeRepositoryPort } from '../episode-store.js';
import type { EpisodicMemory, DecisionOutcome, FeedbackEvent } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

function createMockRepo(): EpisodeRepositoryPort {
  const episodes: EpisodicMemory[] = [];

  return {
    createEpisode: vi.fn(async (input) => {
      const episode: EpisodicMemory = {
        id: `ep_${Date.now()}`,
        userId: input.userId,
        situationSummary: input.situationSummary,
        domain: input.domain,
        situationType: input.situationType,
        contextSnapshot: input.contextSnapshot,
        actionTaken: input.actionTaken,
        outcome: input.outcome,
        decisionId: input.decisionId,
        signalIds: input.signalIds ?? [],
        drawerIds: input.drawerIds ?? [],
        utilityScore: input.utilityScore ?? 0.5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      episodes.push(episode);
      return episode;
    }),

    getEpisodes: vi.fn(async (_userId, options) => {
      let result = episodes.filter((e) => e.userId === _userId);
      if (options?.domain) result = result.filter((e) => e.domain === options.domain);
      if (options?.situationType) result = result.filter((e) => e.situationType === options.situationType);
      if (options?.minUtility !== undefined) result = result.filter((e) => e.utilityScore >= options.minUtility!);
      return result.slice(0, options?.limit ?? 50);
    }),

    getEpisodeByDecision: vi.fn(async (decisionId) =>
      episodes.find((e) => e.decisionId === decisionId) ?? null,
    ),

    updateEpisode: vi.fn(async (episodeId, updates) => {
      const idx = episodes.findIndex((e) => e.id === episodeId);
      if (idx < 0) return null;
      const episode = episodes[idx]!;
      if (updates.feedbackType) episode.feedbackType = updates.feedbackType as EpisodicMemory['feedbackType'];
      if (updates.feedbackDetail) episode.feedbackDetail = updates.feedbackDetail;
      if (updates.outcome) episode.outcome = updates.outcome;
      if (updates.utilityScore !== undefined) episode.utilityScore = updates.utilityScore;
      episode.updatedAt = new Date();
      return episode;
    }),

    searchEpisodes: vi.fn(async (_userId, terms) => {
      return episodes.filter((e) =>
        terms.some((t) => e.situationSummary.toLowerCase().includes(t.toLowerCase())),
      );
    }),
  };
}

describe('EpisodeStore', () => {
  let repo: EpisodeRepositoryPort;
  let store: EpisodeStore;

  beforeEach(() => {
    repo = createMockRepo();
    store = new EpisodeStore(repo);
  });

  describe('recordFromDecision', () => {
    it('should create an episode from a decision outcome', async () => {
      const outcome: DecisionOutcome = {
        id: 'out_1',
        decisionId: 'dec_1',
        selectedAction: {
          id: 'act_1',
          decisionId: 'dec_1',
          actionType: 'archive_email',
          description: 'Archive this email',
          domain: 'email',
          parameters: {},
          estimatedCostCents: 0,
          reversible: true,
          confidence: ConfidenceLevel.HIGH,
          reasoning: 'Low priority email',
        },
        allCandidates: [],
        riskAssessment: null,
        autoExecute: true,
        requiresApproval: false,
        reasoning: 'Auto-archiving low priority email',
        decidedAt: new Date(),
      };

      const episode = await store.recordFromDecision(
        'user1',
        'email',
        'email_triage',
        'Low priority email from newsletter',
        outcome,
        [],
        [],
      );

      expect(episode.domain).toBe('email');
      expect(episode.situationType).toBe('email_triage');
      expect(episode.actionTaken).toBe('Archive this email');
      expect(episode.decisionId).toBe('dec_1');
      expect(episode.utilityScore).toBeGreaterThan(0.5);
    });

    it('should calculate higher utility for auto-executed decisions', async () => {
      const autoOutcome: DecisionOutcome = {
        id: 'out_1',
        decisionId: 'dec_1',
        selectedAction: {
          id: 'act_1',
          decisionId: 'dec_1',
          actionType: 'label_email',
          description: 'Label email',
          domain: 'email',
          parameters: {},
          estimatedCostCents: 0,
          reversible: true,
          confidence: ConfidenceLevel.HIGH,
          reasoning: '',
        },
        allCandidates: [],
        riskAssessment: null,
        autoExecute: true,
        requiresApproval: false,
        reasoning: '',
        decidedAt: new Date(),
      };

      const manualOutcome: DecisionOutcome = {
        ...autoOutcome,
        id: 'out_2',
        decisionId: 'dec_2',
        autoExecute: false,
        requiresApproval: true,
      };

      const autoEp = await store.recordFromDecision('user1', 'email', 'triage', 'auto', autoOutcome, [], []);
      const manualEp = await store.recordFromDecision('user1', 'email', 'triage', 'manual', manualOutcome, [], []);

      expect(autoEp.utilityScore).toBeGreaterThan(manualEp.utilityScore);
    });
  });

  describe('recordFeedback', () => {
    it('should increase utility on approve', async () => {
      const outcome: DecisionOutcome = {
        id: 'out_1',
        decisionId: 'dec_1',
        selectedAction: null,
        allCandidates: [],
        riskAssessment: null,
        autoExecute: false,
        requiresApproval: true,
        reasoning: '',
        decidedAt: new Date(),
      };

      await store.recordFromDecision('user1', 'email', 'triage', 'test', outcome, [], []);

      const feedback: FeedbackEvent = {
        id: 'fb_1',
        userId: 'user1',
        decisionId: 'dec_1',
        feedbackType: 'approve',
        timestamp: new Date(),
      };

      const updated = await store.recordFeedback(feedback);
      expect(updated).not.toBeNull();
      expect(updated!.feedbackType).toBe('approve');
      expect(updated!.utilityScore).toBeGreaterThan(0.5);
    });

    it('should decrease utility on reject', async () => {
      const outcome: DecisionOutcome = {
        id: 'out_1',
        decisionId: 'dec_2',
        selectedAction: null,
        allCandidates: [],
        riskAssessment: null,
        autoExecute: false,
        requiresApproval: true,
        reasoning: '',
        decidedAt: new Date(),
      };

      await store.recordFromDecision('user1', 'email', 'triage', 'test', outcome, [], []);

      const feedback: FeedbackEvent = {
        id: 'fb_2',
        userId: 'user1',
        decisionId: 'dec_2',
        feedbackType: 'reject',
        reason: 'Wrong action',
        timestamp: new Date(),
      };

      const updated = await store.recordFeedback(feedback);
      expect(updated).not.toBeNull();
      expect(updated!.feedbackType).toBe('reject');
      expect(updated!.utilityScore).toBeLessThan(0.5);
    });
  });

  describe('findSimilar', () => {
    it('should find episodes by domain and situation type', async () => {
      const outcome: DecisionOutcome = {
        id: 'out_1',
        decisionId: 'dec_1',
        selectedAction: null,
        allCandidates: [],
        riskAssessment: null,
        autoExecute: false,
        requiresApproval: false,
        reasoning: '',
        decidedAt: new Date(),
      };

      await store.recordFromDecision('user1', 'email', 'email_triage', 'Newsletter from tech digest', outcome, [], []);
      await store.recordFromDecision('user1', 'calendar', 'calendar_conflict', 'Meeting overlap', outcome, [], []);

      const similar = await store.findSimilar('user1', 'email', 'email_triage', ['newsletter'], 5);
      expect(similar.length).toBeGreaterThanOrEqual(1);
      expect(similar[0]!.domain).toBe('email');
    });
  });
});
