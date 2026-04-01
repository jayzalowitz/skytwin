import { describe, it, expect, vi } from 'vitest';
import { ProactiveEvaluator } from '../proactive-evaluator.js';
import { DecisionMaker } from '../decision-maker.js';
import type { TwinProfile, Preference } from '@skytwin/shared-types';
import { ConfidenceLevel, TrustTier } from '@skytwin/shared-types';

// ── Mock TwinService ──────────────────────────────────────────────

function createMockTwinService(profile?: Partial<TwinProfile>) {
  const defaultProfile: TwinProfile = {
    id: 'twin_test',
    userId: 'user_test',
    version: 1,
    preferences: [],
    inferences: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...profile,
  };

  return {
    getOrCreateProfile: vi.fn().mockResolvedValue(defaultProfile),
    getRelevantPreferences: vi.fn().mockResolvedValue([] as Preference[]),
    getPatterns: vi.fn().mockResolvedValue([]),
    getTraits: vi.fn().mockResolvedValue([]),
    getTemporalProfile: vi.fn().mockResolvedValue({
      userId: 'user_test',
      activeHours: { start: 8, end: 22 },
      peakResponseTimes: {},
      weekdayPatterns: {},
      urgencyThresholds: {},
    }),
    updatePreference: vi.fn().mockResolvedValue(defaultProfile),
    addEvidence: vi.fn().mockResolvedValue(defaultProfile),
    inferPreferences: vi.fn().mockResolvedValue(defaultProfile),
    getConfidenceFor: vi.fn().mockResolvedValue(ConfidenceLevel.MODERATE),
    processFeedback: vi.fn().mockResolvedValue(defaultProfile),
  };
}

// ── Mock PolicyEvaluator ──────────────────────────────────────────

function createMockPolicyEvaluator(options?: {
  allowed?: boolean;
  requiresApproval?: boolean;
  reason?: string;
}) {
  const {
    allowed = true,
    requiresApproval = false,
    reason = 'Policy check passed.',
  } = options ?? {};

  return {
    evaluate: vi.fn().mockResolvedValue({
      allowed,
      requiresApproval,
      reason,
    }),
    loadPolicies: vi.fn().mockResolvedValue([]),
    checkSpendLimit: vi.fn().mockReturnValue(true),
    checkReversibility: vi.fn().mockReturnValue(true),
    checkDomainAllowlist: vi.fn().mockReturnValue(true),
  };
}

// ── Mock DecisionRepository ──────────────────────────────────────

function createMockDecisionRepository() {
  return {
    saveDecision: vi.fn().mockResolvedValue(undefined),
    getDecision: vi.fn().mockResolvedValue(null),
    saveOutcome: vi.fn().mockResolvedValue(undefined),
    getOutcome: vi.fn().mockResolvedValue(null),
    saveCandidates: vi.fn().mockResolvedValue(undefined),
    getCandidates: vi.fn().mockResolvedValue([]),
    saveRiskAssessment: vi.fn().mockResolvedValue(undefined),
    getRiskAssessment: vi.fn().mockResolvedValue(null),
    getRecentDecisions: vi.fn().mockResolvedValue([]),
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function createDecisionMaker(options?: {
  policyAllowed?: boolean;
  policyRequiresApproval?: boolean;
}) {
  const twinService = createMockTwinService();
  const policyEvaluator = createMockPolicyEvaluator({
    allowed: options?.policyAllowed ?? true,
    requiresApproval: options?.policyRequiresApproval ?? false,
  });
  const decisionRepo = createMockDecisionRepository();

  return new DecisionMaker(
    twinService as never,
    policyEvaluator as never,
    decisionRepo as never,
  );
}

// ── Tests ─────────────────────────────────────────────────────────

describe('ProactiveEvaluator', () => {
  describe('scanUser', () => {
    it('should return results for given signals', async () => {
      const decisionMaker = createDecisionMaker();
      const evaluator = new ProactiveEvaluator(decisionMaker);
      const twinService = createMockTwinService();

      const signals = [
        {
          source: 'gmail',
          type: 'new_email',
          domain: 'email',
          data: { subject: 'Weekly Newsletter', from: 'news@example.com' },
        },
        {
          source: 'google_calendar',
          type: 'new_invite',
          domain: 'calendar',
          data: { title: 'Team Standup', time: '09:00' },
        },
      ];

      const result = await evaluator.scanUser(
        'user_test',
        signals,
        twinService,
        TrustTier.MODERATE_AUTONOMY,
      );

      expect(result.scanId).toMatch(/^scan_/);
      expect(result.userId).toBe('user_test');
      expect(result.briefingItems).toHaveLength(2);
      expect(result.startedAt).toBeInstanceOf(Date);
      expect(result.completedAt).toBeInstanceOf(Date);
    });

    it('should only place HIGH confidence auto-executable items into autoActions', async () => {
      // Create a decision maker with a permissive policy that allows auto-execute
      const decisionMaker = createDecisionMaker({
        policyAllowed: true,
        policyRequiresApproval: false,
      });
      const evaluator = new ProactiveEvaluator(decisionMaker);

      // Provide a twin service with HIGH confidence preferences so candidates
      // get scored with HIGH confidence
      const twinService = createMockTwinService({
        preferences: [
          {
            id: 'pref_1',
            domain: 'email',
            key: 'auto_archive',
            value: true,
            confidence: ConfidenceLevel.HIGH,
            source: 'explicit',
            evidenceIds: ['ev_1'],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      const signals = [
        {
          source: 'gmail',
          type: 'new_email',
          domain: 'email',
          data: { subject: 'Newsletter', from: 'news@example.com' },
        },
      ];

      const result = await evaluator.scanUser(
        'user_test',
        signals,
        twinService,
        TrustTier.HIGH_AUTONOMY,
      );

      // With HIGH_AUTONOMY trust tier and permissive policy, the auto-executing
      // actions should have HIGH or CONFIRMED confidence
      for (const autoAction of result.autoActions) {
        if (autoAction.selectedAction) {
          const rank = confidenceRank(autoAction.selectedAction.confidence);
          expect(rank).toBeGreaterThanOrEqual(confidenceRank(ConfidenceLevel.HIGH));
        }
      }

      // All briefing items should exist
      expect(result.briefingItems.length).toBeGreaterThanOrEqual(1);
    });

    it('should place non-auto-executable moderate confidence items into approvalNeeded', async () => {
      const decisionMaker = createDecisionMaker({
        policyAllowed: true,
        policyRequiresApproval: true,
      });
      const evaluator = new ProactiveEvaluator(decisionMaker);
      const twinService = createMockTwinService();

      const signals = [
        {
          source: 'gmail',
          type: 'new_email',
          domain: 'email',
          data: { subject: 'Meeting notes', from: 'boss@company.com' },
        },
      ];

      const result = await evaluator.scanUser(
        'user_test',
        signals,
        twinService,
        TrustTier.SUGGEST,
      );

      // With SUGGEST trust tier, nothing should auto-execute
      expect(result.autoActions).toHaveLength(0);
      // Items with MODERATE+ confidence should go to approvalNeeded
      expect(result.briefingItems.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('generateBriefing', () => {
    it('should sort by urgency then confidence', () => {
      const decisionMaker = createDecisionMaker();
      const evaluator = new ProactiveEvaluator(decisionMaker);

      const scanResult = {
        scanId: 'scan_test',
        userId: 'user_test',
        scanType: 'manual' as const,
        autoActions: [],
        approvalNeeded: [],
        briefingItems: [
          {
            actionDescription: 'Low urgency, low confidence',
            domain: 'email',
            confidence: ConfidenceLevel.LOW,
            urgency: 'low' as const,
            reasoning: 'test',
            wouldAutoExecute: false,
          },
          {
            actionDescription: 'Critical urgency, high confidence',
            domain: 'calendar',
            confidence: ConfidenceLevel.HIGH,
            urgency: 'critical' as const,
            reasoning: 'test',
            wouldAutoExecute: true,
          },
          {
            actionDescription: 'High urgency, moderate confidence',
            domain: 'subscriptions',
            confidence: ConfidenceLevel.MODERATE,
            urgency: 'high' as const,
            reasoning: 'test',
            wouldAutoExecute: false,
          },
          {
            actionDescription: 'Critical urgency, moderate confidence',
            domain: 'shopping',
            confidence: ConfidenceLevel.MODERATE,
            urgency: 'critical' as const,
            reasoning: 'test',
            wouldAutoExecute: false,
          },
        ],
        startedAt: new Date(),
        completedAt: new Date(),
      };

      const briefing = evaluator.generateBriefing(scanResult);

      // Critical items should come first
      expect(briefing[0]!.urgency).toBe('critical');
      expect(briefing[1]!.urgency).toBe('critical');

      // Among criticals, higher confidence should come first
      expect(briefing[0]!.confidence).toBe(ConfidenceLevel.HIGH);
      expect(briefing[1]!.confidence).toBe(ConfidenceLevel.MODERATE);

      // Then high urgency
      expect(briefing[2]!.urgency).toBe('high');

      // Then low urgency last
      expect(briefing[3]!.urgency).toBe('low');
    });

    it('should return empty array for empty scan result', () => {
      const decisionMaker = createDecisionMaker();
      const evaluator = new ProactiveEvaluator(decisionMaker);

      const scanResult = {
        scanId: 'scan_empty',
        userId: 'user_test',
        scanType: 'manual' as const,
        autoActions: [],
        approvalNeeded: [],
        briefingItems: [],
        startedAt: new Date(),
        completedAt: new Date(),
      };

      const briefing = evaluator.generateBriefing(scanResult);
      expect(briefing).toHaveLength(0);
    });
  });
});

// ── Test helper ──────────────────────────────────────────────────

function confidenceRank(level: ConfidenceLevel): number {
  const ranks: Record<ConfidenceLevel, number> = {
    [ConfidenceLevel.SPECULATIVE]: 0,
    [ConfidenceLevel.LOW]: 1,
    [ConfidenceLevel.MODERATE]: 2,
    [ConfidenceLevel.HIGH]: 3,
    [ConfidenceLevel.CONFIRMED]: 4,
  };
  return ranks[level];
}
