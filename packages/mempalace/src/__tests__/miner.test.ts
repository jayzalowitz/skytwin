import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryMiner } from '../miner.js';
import type { Palace } from '../palace.js';
import type { KnowledgeGraph } from '../knowledge-graph.js';
import type { EpisodeStore } from '../episode-store.js';
import type { TwinEvidence, DecisionOutcome, FeedbackEvent, MemoryDrawer } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

function createMockPalace(): Palace {
  const filed: MemoryDrawer[] = [];
  return {
    fileMemory: vi.fn(async (_userId, _domain, _topic, _hall, content, metadata, sourceType, sourceId) => {
      const drawer: MemoryDrawer = {
        id: `drawer_${Date.now()}`,
        roomId: 'room_1',
        wingId: 'wing_1',
        userId: _userId,
        hall: _hall,
        content,
        metadata: { importance: 0.5, ...metadata },
        sourceType,
        sourceId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      filed.push(drawer);
      return drawer;
    }),
    _filed: filed,
  } as unknown as Palace;
}

function createMockKG(): KnowledgeGraph {
  return {
    extractEntitiesFromText: vi.fn(() => [{ name: 'Alice', entityType: 'person' as const }]),
    recordEntity: vi.fn(async () => ({
      id: 'ent_1',
      userId: 'user1',
      name: 'Alice',
      entityType: 'person',
      properties: {},
      aliases: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    recordFact: vi.fn(async () => ({
      id: 'triple_1',
      userId: 'user1',
      subject: 'test',
      predicate: 'is',
      object: 'value',
      validFrom: new Date(),
      validTo: null,
      confidence: ConfidenceLevel.MODERATE,
      extractedAt: new Date(),
    })),
  } as unknown as KnowledgeGraph;
}

function createMockEpisodeStore(): EpisodeStore {
  return {
    recordFromDecision: vi.fn(async () => ({
      id: 'ep_1',
      userId: 'user1',
      situationSummary: 'test',
      domain: 'email',
      situationType: 'email_triage',
      contextSnapshot: {},
      signalIds: [],
      drawerIds: [],
      utilityScore: 0.5,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    recordFeedback: vi.fn(async () => null),
  } as unknown as EpisodeStore;
}

describe('MemoryMiner', () => {
  let palace: Palace;
  let kg: KnowledgeGraph;
  let episodeStore: EpisodeStore;
  let miner: MemoryMiner;

  beforeEach(() => {
    palace = createMockPalace();
    kg = createMockKG();
    episodeStore = createMockEpisodeStore();
    miner = new MemoryMiner(palace, kg, episodeStore);
  });

  describe('mineEvidence', () => {
    it('should file a drawer and extract entities from evidence', async () => {
      const evidence: TwinEvidence = {
        id: 'ev_1',
        userId: 'user1',
        source: 'gmail',
        type: 'email',
        domain: 'email',
        data: { subject: 'Project Update', from: 'alice@acme.com' },
        timestamp: new Date(),
      };

      const drawer = await miner.mineEvidence('user1', evidence);

      expect(drawer.content).toContain('gmail/email');
      expect(palace.fileMemory).toHaveBeenCalledOnce();
      expect(kg.extractEntitiesFromText).toHaveBeenCalled();
      expect(kg.recordEntity).toHaveBeenCalled();
    });

    it('should extract email domain facts', async () => {
      const evidence: TwinEvidence = {
        id: 'ev_2',
        userId: 'user1',
        source: 'gmail',
        type: 'email',
        domain: 'email',
        data: { from: 'bob.jones@customdomain.io', subject: 'Hello' },
        timestamp: new Date(),
      };

      await miner.mineEvidence('user1', evidence);
      expect(kg.recordFact).toHaveBeenCalled();
    });

    it('should not extract facts from common email providers', async () => {
      const evidence: TwinEvidence = {
        id: 'ev_3',
        userId: 'user1',
        source: 'gmail',
        type: 'email',
        domain: 'email',
        data: { from: 'someone@gmail.com' },
        timestamp: new Date(),
      };

      await miner.mineEvidence('user1', evidence);
      // recordFact may still be called for other things, but not for gmail.com
      const calls = (kg.recordFact as ReturnType<typeof vi.fn>).mock.calls;
      const emailCalls = calls.filter((c: unknown[]) => c[2] === 'emails_from');
      expect(emailCalls.length).toBe(0);
    });

    it('should assess higher importance for financial signals', async () => {
      const evidence: TwinEvidence = {
        id: 'ev_4',
        userId: 'user1',
        source: 'bank',
        type: 'transaction',
        domain: 'finance',
        data: { amount: 500, description: 'Payment' },
        timestamp: new Date(),
      };

      await miner.mineEvidence('user1', evidence);
      const call = (palace.fileMemory as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const metadata = call[5] as Record<string, unknown>;
      expect(metadata['importance']).toBeGreaterThan(0.5);
    });
  });

  describe('mineDecision', () => {
    it('should create an episode and file advice drawer', async () => {
      const outcome: DecisionOutcome = {
        id: 'out_1',
        decisionId: 'dec_1',
        selectedAction: {
          id: 'act_1',
          decisionId: 'dec_1',
          actionType: 'archive_email',
          description: 'Archive the email',
          domain: 'email',
          parameters: {},
          estimatedCostCents: 0,
          reversible: true,
          confidence: ConfidenceLevel.HIGH,
          reasoning: 'Low priority',
        },
        allCandidates: [],
        riskAssessment: null,
        autoExecute: true,
        requiresApproval: false,
        reasoning: 'Auto-archive low priority email',
        decidedAt: new Date(),
      };

      await miner.mineDecision('user1', 'email', 'email_triage', 'Newsletter from tech digest', outcome, [], []);

      expect(episodeStore.recordFromDecision).toHaveBeenCalledOnce();
      expect(palace.fileMemory).toHaveBeenCalledOnce(); // advice drawer
    });
  });

  describe('mineFeedback', () => {
    it('should update episode and file a correction drawer on undo', async () => {
      const feedback: FeedbackEvent = {
        id: 'fb_1',
        userId: 'user1',
        decisionId: 'dec_1',
        feedbackType: 'undo',
        reason: 'The email was important',
        timestamp: new Date(),
      };

      await miner.mineFeedback('user1', feedback);

      expect(episodeStore.recordFeedback).toHaveBeenCalledOnce();
      expect(palace.fileMemory).toHaveBeenCalledOnce(); // correction drawer
    });

    it('should file correction drawer on correct feedback', async () => {
      const feedback: FeedbackEvent = {
        id: 'fb_2',
        userId: 'user1',
        decisionId: 'dec_2',
        feedbackType: 'correct',
        correctedAction: 'label instead of archive',
        timestamp: new Date(),
      };

      await miner.mineFeedback('user1', feedback);
      expect(palace.fileMemory).toHaveBeenCalledOnce();
    });

    it('should not file correction drawer on approve', async () => {
      const feedback: FeedbackEvent = {
        id: 'fb_3',
        userId: 'user1',
        decisionId: 'dec_3',
        feedbackType: 'approve',
        timestamp: new Date(),
      };

      await miner.mineFeedback('user1', feedback);
      expect(palace.fileMemory).not.toHaveBeenCalled();
    });
  });
});
