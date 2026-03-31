import { describe, it, expect, vi } from 'vitest';
import { DecisionMaker } from '../decision-maker.js';
import type {
  DecisionContext,
  DecisionObject,
  TwinProfile,
  Preference,
} from '@skytwin/shared-types';
import {
  ConfidenceLevel,
  SituationType,
  TrustTier,
} from '@skytwin/shared-types';

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
    getRelevantPreferences: vi.fn().mockResolvedValue(defaultProfile.preferences),
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
  const { allowed = true, requiresApproval = false, reason = 'Policy check passed.' } = options ?? {};

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
    saveOutcome: vi.fn().mockResolvedValue(undefined),
    saveRiskAssessment: vi.fn().mockResolvedValue(undefined),
    saveCandidates: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function createEmailDecision(overrides?: Partial<DecisionObject>): DecisionObject {
  return {
    id: 'dec_test_001',
    situationType: SituationType.EMAIL_TRIAGE,
    domain: 'email',
    urgency: 'low',
    summary: 'Email triage needed for "Weekly Newsletter"',
    rawData: {
      from: 'newsletter@techdigest.com',
      subject: 'Weekly Newsletter',
      importance: 'low',
      category: 'newsletter',
    },
    interpretedAt: new Date(),
    ...overrides,
  };
}

function createContext(
  trustTier: TrustTier = TrustTier.MODERATE_AUTONOMY,
  decision?: DecisionObject,
  preferences?: Preference[],
): DecisionContext {
  return {
    userId: 'user_test',
    decision: decision ?? createEmailDecision(),
    trustTier,
    relevantPreferences: preferences ?? [],
    timestamp: new Date(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('DecisionMaker', () => {
  let decisionMaker: DecisionMaker;

  describe('Low-risk action on trusted user', () => {
    it('should auto-execute a low-risk action for a trusted user', async () => {
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

      const policyEvaluator = createMockPolicyEvaluator({
        allowed: true,
        requiresApproval: false,
      });

      const decisionRepo = createMockDecisionRepository();
      decisionMaker = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      const context = createContext(TrustTier.HIGH_AUTONOMY);
      const outcome = await decisionMaker.evaluate(context);

      expect(outcome.selectedAction).not.toBeNull();
      expect(outcome.autoExecute).toBe(true);
      expect(outcome.requiresApproval).toBe(false);
    });
  });

  describe('High-risk action', () => {
    it('should require approval for a high-risk action', async () => {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator({
        allowed: true,
        requiresApproval: true,
        reason: 'High risk action requires approval.',
      });
      const decisionRepo = createMockDecisionRepository();

      decisionMaker = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      const decision = createEmailDecision({
        rawData: {
          from: 'admin@company.com',
          subject: 'Delete all emails',
          importance: 'high',
          category: 'administrative',
        },
      });

      const context = createContext(TrustTier.HIGH_AUTONOMY, decision);
      const outcome = await decisionMaker.evaluate(context);

      expect(outcome.requiresApproval).toBe(true);
      expect(outcome.autoExecute).toBe(false);
    });
  });

  describe('Blocked domain', () => {
    it('should deny action when policy blocks it', async () => {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator({
        allowed: false,
        requiresApproval: false,
        reason: 'Domain is blocked.',
      });
      const decisionRepo = createMockDecisionRepository();

      decisionMaker = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      const context = createContext(TrustTier.HIGH_AUTONOMY);
      const outcome = await decisionMaker.evaluate(context);

      // When all candidates are blocked, the outcome should have no selected action
      // or should not auto-execute
      expect(outcome.autoExecute).toBe(false);
    });
  });

  describe('Insufficient confidence', () => {
    it('should escalate when confidence is too low', async () => {
      const twinService = createMockTwinService({
        preferences: [],
        inferences: [],
      });

      const policyEvaluator = createMockPolicyEvaluator({
        allowed: true,
        requiresApproval: false,
      });
      const decisionRepo = createMockDecisionRepository();

      decisionMaker = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      // Use observer trust tier which should not auto-execute
      const context = createContext(TrustTier.OBSERVER);
      const outcome = await decisionMaker.evaluate(context);

      expect(outcome.autoExecute).toBe(false);
    });
  });

  describe('Multiple candidates', () => {
    it('should select the best candidate from multiple options', async () => {
      const twinService = createMockTwinService({
        preferences: [
          {
            id: 'pref_archive',
            domain: 'email',
            key: 'auto_archive',
            value: true,
            confidence: ConfidenceLevel.HIGH,
            source: 'explicit',
            evidenceIds: ['ev_1', 'ev_2', 'ev_3'],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      const policyEvaluator = createMockPolicyEvaluator({
        allowed: true,
        requiresApproval: false,
      });
      const decisionRepo = createMockDecisionRepository();

      decisionMaker = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      const context = createContext(TrustTier.HIGH_AUTONOMY);
      const outcome = await decisionMaker.evaluate(context);

      expect(outcome.selectedAction).not.toBeNull();
      expect(outcome.allCandidates.length).toBeGreaterThan(1);
      // The selected action should be among the candidates
      expect(
        outcome.allCandidates.some((c) => c.id === outcome.selectedAction?.id),
      ).toBe(true);
    });
  });

  describe('Candidate generation', () => {
    it('should generate candidates based on situation type', () => {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator();
      const decisionRepo = createMockDecisionRepository();

      decisionMaker = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      const profile: TwinProfile = {
        id: 'twin_1',
        userId: 'user_1',
        version: 1,
        preferences: [],
        inferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const decision = createEmailDecision();
      const candidates = decisionMaker.generateCandidates(decision, profile);

      expect(candidates.length).toBeGreaterThan(0);
      // All candidates should belong to the email domain
      for (const c of candidates) {
        expect(c.domain).toBe('email');
        expect(c.decisionId).toBe(decision.id);
      }
    });
  });
});
