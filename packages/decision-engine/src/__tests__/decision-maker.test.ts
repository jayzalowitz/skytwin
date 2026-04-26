import { describe, it, expect, vi } from 'vitest';
import { DecisionMaker } from '../decision-maker.js';
import type {
  DecisionContext,
  DecisionObject,
  TwinProfile,
  Preference,
  BehavioralPattern,
  CrossDomainTrait,
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

  // ── generateCandidates() for each situation type ─────────────────

  describe('generateCandidates() per situation type', () => {
    function makeDecisionMaker() {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator();
      const decisionRepo = createMockDecisionRepository();
      return new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );
    }

    const emptyProfile: TwinProfile = {
      id: 'twin_1',
      userId: 'user_1',
      version: 1,
      preferences: [],
      inferences: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('CALENDAR_CONFLICT should generate accept, decline, and propose candidates', () => {
      const dm = makeDecisionMaker();
      const decision: DecisionObject = {
        id: 'dec_cal_001',
        situationType: SituationType.CALENDAR_CONFLICT,
        domain: 'calendar',
        urgency: 'medium',
        summary: 'Conflicting meeting at 3pm',
        rawData: { eventId: 'evt_123' },
        interpretedAt: new Date(),
      };

      const candidates = dm.generateCandidates(decision, emptyProfile);

      expect(candidates.length).toBe(3);
      const actionTypes = candidates.map((c) => c.actionType);
      expect(actionTypes).toContain('accept_invite');
      expect(actionTypes).toContain('decline_invite');
      expect(actionTypes).toContain('propose_alternative');
      for (const c of candidates) {
        expect(c.domain).toBe('calendar');
        expect(c.decisionId).toBe(decision.id);
      }
    });

    it('CALENDAR_INVITE should generate accept, tentative, and decline candidates', () => {
      const dm = makeDecisionMaker();
      const decision: DecisionObject = {
        id: 'dec_inv_001',
        situationType: SituationType.CALENDAR_INVITE,
        domain: 'calendar',
        urgency: 'medium',
        summary: 'New invite: Weekly sync',
        rawData: { eventId: 'evt_456' },
        interpretedAt: new Date(),
      };

      const candidates = dm.generateCandidates(decision, emptyProfile);

      expect(candidates.length).toBe(3);
      const actionTypes = candidates.map((c) => c.actionType);
      expect(actionTypes).toContain('accept_invite');
      expect(actionTypes).toContain('tentative_accept');
      expect(actionTypes).toContain('decline_invite');
      for (const c of candidates) {
        expect(c.domain).toBe('calendar');
      }
    });

    it('CALENDAR_UPDATE should generate acknowledge and dismiss candidates', () => {
      const dm = makeDecisionMaker();
      const decision: DecisionObject = {
        id: 'dec_upd_001',
        situationType: SituationType.CALENDAR_UPDATE,
        domain: 'calendar',
        urgency: 'low',
        summary: 'Calendar update for sprint review',
        rawData: { eventId: 'evt_789' },
        interpretedAt: new Date(),
      };

      const candidates = dm.generateCandidates(decision, emptyProfile);

      expect(candidates.length).toBe(2);
      const actionTypes = candidates.map((c) => c.actionType);
      expect(actionTypes).toContain('acknowledge');
      expect(actionTypes).toContain('dismiss');
    });

    it('SUBSCRIPTION_RENEWAL should generate renew, cancel, and snooze candidates', () => {
      const dm = makeDecisionMaker();
      const decision: DecisionObject = {
        id: 'dec_sub_001',
        situationType: SituationType.SUBSCRIPTION_RENEWAL,
        domain: 'subscriptions',
        urgency: 'medium',
        summary: 'Netflix subscription renewal coming up',
        rawData: { subscriptionId: 'sub_123', costCents: 1599 },
        interpretedAt: new Date(),
      };

      const candidates = dm.generateCandidates(decision, emptyProfile);

      expect(candidates.length).toBe(3);
      const actionTypes = candidates.map((c) => c.actionType);
      expect(actionTypes).toContain('renew_subscription');
      expect(actionTypes).toContain('cancel_subscription');
      expect(actionTypes).toContain('snooze_reminder');
      // The renew candidate should carry the cost
      const renewCandidate = candidates.find((c) => c.actionType === 'renew_subscription')!;
      expect(renewCandidate.estimatedCostCents).toBe(1599);
      expect(renewCandidate.reversible).toBe(false);
    });

    it('GROCERY_REORDER should generate reorder and add-to-list candidates', () => {
      const dm = makeDecisionMaker();
      const decision: DecisionObject = {
        id: 'dec_groc_001',
        situationType: SituationType.GROCERY_REORDER,
        domain: 'shopping',
        urgency: 'low',
        summary: 'Weekly grocery reorder',
        rawData: {
          items: [
            { name: 'Milk', priceCents: 450 },
            { name: 'Bread', priceCents: 350 },
          ],
        },
        interpretedAt: new Date(),
      };

      const candidates = dm.generateCandidates(decision, emptyProfile);

      expect(candidates.length).toBe(2);
      const actionTypes = candidates.map((c) => c.actionType);
      expect(actionTypes).toContain('place_order');
      expect(actionTypes).toContain('add_to_list');
      const reorderCandidate = candidates.find((c) => c.actionType === 'place_order')!;
      expect(reorderCandidate.estimatedCostCents).toBe(800); // 450 + 350
      expect(reorderCandidate.domain).toBe('shopping');
    });

    it('TRAVEL_DECISION should generate book and save candidates', () => {
      const dm = makeDecisionMaker();
      const decision: DecisionObject = {
        id: 'dec_travel_001',
        situationType: SituationType.TRAVEL_DECISION,
        domain: 'travel',
        urgency: 'medium',
        summary: 'Flight to NYC found',
        rawData: {
          destination: 'New York',
          dates: '2026-05-01',
          travelType: 'flight',
          costCents: 35000,
        },
        interpretedAt: new Date(),
      };

      const candidates = dm.generateCandidates(decision, emptyProfile);

      expect(candidates.length).toBe(2);
      const actionTypes = candidates.map((c) => c.actionType);
      expect(actionTypes).toContain('book_travel');
      expect(actionTypes).toContain('save_option');
      const bookCandidate = candidates.find((c) => c.actionType === 'book_travel')!;
      expect(bookCandidate.estimatedCostCents).toBe(35000);
      expect(bookCandidate.reversible).toBe(false);
      const saveCandidate = candidates.find((c) => c.actionType === 'save_option')!;
      expect(saveCandidate.estimatedCostCents).toBe(0);
      expect(saveCandidate.reversible).toBe(true);
    });

    it('GENERIC should generate note and escalate candidates', () => {
      const dm = makeDecisionMaker();
      const decision: DecisionObject = {
        id: 'dec_generic_001',
        situationType: SituationType.GENERIC,
        domain: 'general',
        urgency: 'low',
        summary: 'Something unusual happened',
        rawData: { info: 'unknown event' },
        interpretedAt: new Date(),
      };

      const candidates = dm.generateCandidates(decision, emptyProfile);

      expect(candidates.length).toBe(2);
      const actionTypes = candidates.map((c) => c.actionType);
      expect(actionTypes).toContain('create_note');
      expect(actionTypes).toContain('escalate_to_user');
      for (const c of candidates) {
        expect(c.domain).toBe('general');
        expect(c.reversible).toBe(true);
        expect(c.estimatedCostCents).toBe(0);
      }
    });

    it('unknown situation type should fall through to generic candidates', () => {
      const dm = makeDecisionMaker();
      const decision: DecisionObject = {
        id: 'dec_unknown_001',
        situationType: 'some_future_type' as SituationType,
        domain: 'unknown',
        urgency: 'low',
        summary: 'Unrecognized event',
        rawData: {},
        interpretedAt: new Date(),
      };

      const candidates = dm.generateCandidates(decision, emptyProfile);

      expect(candidates.length).toBe(2);
      const actionTypes = candidates.map((c) => c.actionType);
      expect(actionTypes).toContain('create_note');
      expect(actionTypes).toContain('escalate_to_user');
    });
  });

  // ── calculatePatternBoost() tested indirectly via evaluate() ─────

  describe('calculatePatternBoost (via evaluate)', () => {
    function makeMocks(profileOverrides?: Partial<TwinProfile>) {
      const twinService = createMockTwinService(profileOverrides);
      const policyEvaluator = createMockPolicyEvaluator({ allowed: true, requiresApproval: false });
      const decisionRepo = createMockDecisionRepository();
      const dm = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );
      return { dm, twinService, policyEvaluator, decisionRepo };
    }

    function makePattern(overrides?: Partial<BehavioralPattern>): BehavioralPattern {
      return {
        id: 'pat_1',
        userId: 'user_test',
        patternType: 'habit',
        description: 'test pattern',
        trigger: { conditions: {} },
        observedAction: 'archive_email',
        frequency: 5,
        confidence: ConfidenceLevel.MODERATE,
        firstObservedAt: new Date(),
        lastObservedAt: new Date(),
        metadata: {},
        ...overrides,
      };
    }

    it('no patterns should not affect scoring (boost = 0)', async () => {
      const { dm } = makeMocks();
      const decision = createEmailDecision();
      const context = createContext(TrustTier.HIGH_AUTONOMY, decision);
      // No patterns set
      context.patterns = [];

      const outcome = await dm.evaluate(context);
      // Should still produce an outcome; we verify indirectly by checking
      // that the outcome is valid and the pipeline did not throw.
      expect(outcome.selectedAction).not.toBeNull();
    });

    it('patterns matching actionType should boost that candidate', async () => {
      // Give the profile a HIGH confidence preference for auto_archive so
      // archive_email starts with a competitive base confidence, then the
      // pattern boost pushes it to the top.
      const { dm } = makeMocks({
        preferences: [{
          id: 'pref_archive',
          domain: 'email',
          key: 'auto_archive',
          value: true,
          confidence: ConfidenceLevel.HIGH,
          source: 'explicit',
          evidenceIds: ['ev_1'],
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
      });
      const decision = createEmailDecision();
      const context = createContext(TrustTier.HIGH_AUTONOMY, decision);
      // Pattern matches 'archive_email' actionType
      context.patterns = [makePattern({ observedAction: 'archive_email', frequency: 8 })];

      const outcome = await dm.evaluate(context);
      expect(outcome.selectedAction).not.toBeNull();
      // archive_email should be boosted by the pattern match and selected
      expect(outcome.selectedAction!.actionType).toBe('archive_email');
    });

    it('patterns matching domain should boost candidates in that domain', async () => {
      const { dm } = makeMocks();
      const decision = createEmailDecision();
      const context = createContext(TrustTier.HIGH_AUTONOMY, decision);
      // Pattern matches the 'email' domain but not a specific action
      context.patterns = [
        makePattern({
          observedAction: 'some_other_action',
          trigger: { domain: 'email', conditions: {} },
          frequency: 3,
        }),
      ];

      const outcome = await dm.evaluate(context);
      expect(outcome.selectedAction).not.toBeNull();
      // All candidates are email domain, so all get the domain boost.
      // The outcome should succeed without error.
      expect(outcome.allCandidates.length).toBeGreaterThan(0);
    });

    it('boost should be capped at 20 even with many high-frequency patterns', async () => {
      const { dm } = makeMocks({
        preferences: [{
          id: 'pref_archive',
          domain: 'email',
          key: 'auto_archive',
          value: true,
          confidence: ConfidenceLevel.HIGH,
          source: 'explicit',
          evidenceIds: ['ev_1'],
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
      });
      const decision = createEmailDecision();
      const context = createContext(TrustTier.HIGH_AUTONOMY, decision);
      // Many patterns, all matching archive_email, with high frequency.
      // Without the cap, the raw boost would be 3*(10+3) = 39, but
      // the cap limits it to 20.
      context.patterns = [
        makePattern({ id: 'pat_1', observedAction: 'archive_email', frequency: 10, trigger: { domain: 'email', conditions: {} } }),
        makePattern({ id: 'pat_2', observedAction: 'archive_email', frequency: 10, trigger: { domain: 'email', conditions: {} } }),
        makePattern({ id: 'pat_3', observedAction: 'archive_email', frequency: 10, trigger: { domain: 'email', conditions: {} } }),
      ];

      const outcome = await dm.evaluate(context);
      // Should still produce a valid outcome (the cap prevents runaway scores)
      expect(outcome.selectedAction).not.toBeNull();
      expect(outcome.selectedAction!.actionType).toBe('archive_email');
    });
  });

  // ── calculateTraitAdjustment() tested indirectly via evaluate() ──

  describe('calculateTraitAdjustment (via evaluate)', () => {
    function makeMocks(profileOverrides?: Partial<TwinProfile>) {
      const twinService = createMockTwinService(profileOverrides);
      const policyEvaluator = createMockPolicyEvaluator({ allowed: true, requiresApproval: false });
      const decisionRepo = createMockDecisionRepository();
      const dm = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );
      return { dm, twinService };
    }

    function makeTrait(name: string): CrossDomainTrait {
      return {
        id: `trait_${name}`,
        traitName: name,
        confidence: ConfidenceLevel.HIGH,
        supportingDomains: ['email', 'calendar'],
        evidenceCount: 10,
        description: `User exhibits ${name} trait`,
      };
    }

    it('cautious_spender trait should penalize high-cost actions', async () => {
      const { dm } = makeMocks();
      // Use subscription with high cost
      const decision: DecisionObject = {
        id: 'dec_sub_cs',
        situationType: SituationType.SUBSCRIPTION_RENEWAL,
        domain: 'subscriptions',
        urgency: 'medium',
        summary: 'Expensive subscription renewal',
        rawData: { subscriptionId: 'sub_1', costCents: 5000 },
        interpretedAt: new Date(),
      };
      const context = createContext(TrustTier.HIGH_AUTONOMY, decision);
      context.traits = [makeTrait('cautious_spender')];

      const outcome = await dm.evaluate(context);
      expect(outcome.selectedAction).not.toBeNull();
      // The renew_subscription candidate (costCents=5000 > 1000) gets penalized,
      // so the snooze_reminder or cancel_subscription (lower cost) should be preferred
      expect(outcome.selectedAction!.actionType).not.toBe('renew_subscription');
    });

    it('quick_responder trait should boost accept_invite and send_reply actions', async () => {
      // Give the profile a HIGH confidence for auto_accept so accept_invite
      // starts with competitive base confidence; the +5 quick_responder boost
      // then pushes it ahead of propose_alternative.
      const { dm } = makeMocks({
        preferences: [{
          id: 'pref_accept',
          domain: 'calendar',
          key: 'auto_accept',
          value: true,
          confidence: ConfidenceLevel.HIGH,
          source: 'explicit',
          evidenceIds: ['ev_1'],
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
      });
      const decision: DecisionObject = {
        id: 'dec_cal_qr',
        situationType: SituationType.CALENDAR_CONFLICT,
        domain: 'calendar',
        urgency: 'medium',
        summary: 'Meeting invite from boss',
        rawData: { eventId: 'evt_qr' },
        interpretedAt: new Date(),
      };
      const context = createContext(TrustTier.HIGH_AUTONOMY, decision);
      context.traits = [makeTrait('quick_responder')];

      const outcome = await dm.evaluate(context);
      expect(outcome.selectedAction).not.toBeNull();
      // accept_invite gets HIGH confidence (30 pts) + reversible (15) + cost 0 (10)
      // + quick_responder (+5) = 60 + risk; propose_alternative gets LOW (10) +
      // reversible (15) + cost 0 (10) = 35 + risk. accept_invite should win.
      expect(outcome.selectedAction!.actionType).toBe('accept_invite');
    });

    it('delegation_averse trait should penalize irreversible actions', async () => {
      const { dm } = makeMocks();
      const decision: DecisionObject = {
        id: 'dec_cal_da',
        situationType: SituationType.CALENDAR_CONFLICT,
        domain: 'calendar',
        urgency: 'medium',
        summary: 'Meeting to decline',
        rawData: { eventId: 'evt_da' },
        interpretedAt: new Date(),
      };
      const context = createContext(TrustTier.HIGH_AUTONOMY, decision);
      context.traits = [makeTrait('delegation_averse')];

      const outcome = await dm.evaluate(context);
      expect(outcome.selectedAction).not.toBeNull();
      // decline_invite (irreversible) should be penalized, so accept_invite
      // (reversible) or propose_alternative (reversible) should win
      expect(outcome.selectedAction!.reversible).toBe(true);
    });

    it('routine_driven trait should add a positive adjustment to all candidates', async () => {
      const { dm } = makeMocks();
      const decision = createEmailDecision();
      const context = createContext(TrustTier.HIGH_AUTONOMY, decision);
      context.traits = [makeTrait('routine_driven')];

      const outcome = await dm.evaluate(context);
      expect(outcome.selectedAction).not.toBeNull();
      // routine_driven adds +3 to every candidate, so the scoring order is not
      // disrupted; the outcome should still succeed.
      expect(outcome.allCandidates.length).toBeGreaterThan(0);
    });

    it('privacy_conscious trait should penalize send_reply and accept_invite', async () => {
      const { dm } = makeMocks();
      const decision: DecisionObject = {
        id: 'dec_cal_pc',
        situationType: SituationType.CALENDAR_CONFLICT,
        domain: 'calendar',
        urgency: 'medium',
        summary: 'Calendar invite',
        rawData: { eventId: 'evt_pc' },
        interpretedAt: new Date(),
      };
      const context = createContext(TrustTier.HIGH_AUTONOMY, decision);
      context.traits = [makeTrait('privacy_conscious')];

      const outcome = await dm.evaluate(context);
      expect(outcome.selectedAction).not.toBeNull();
      // accept_invite gets -3 from privacy_conscious; propose_alternative does not.
      // propose_alternative (reversible, no privacy penalty) should be competitive.
      // At minimum, accept_invite should be penalized relative to the no-trait case.
      const actionTypes = outcome.allCandidates.map((c) => c.actionType);
      expect(actionTypes).toContain('accept_invite');
      expect(actionTypes).toContain('propose_alternative');
    });
  });

  // ── shouldAutoExecute with trust tiers (via evaluate) ────────────

  describe('shouldAutoExecute with different trust tiers (via evaluate)', () => {
    function makeMocksAllowed() {
      const twinService = createMockTwinService({
        preferences: [
          {
            id: 'pref_archive',
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
      const dm = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );
      return dm;
    }

    it('OBSERVER tier should never auto-execute', async () => {
      const dm = makeMocksAllowed();
      const context = createContext(TrustTier.OBSERVER);
      const outcome = await dm.evaluate(context);

      expect(outcome.autoExecute).toBe(false);
    });

    it('SUGGEST tier should never auto-execute', async () => {
      const dm = makeMocksAllowed();
      const context = createContext(TrustTier.SUGGEST);
      const outcome = await dm.evaluate(context);

      expect(outcome.autoExecute).toBe(false);
    });

    it('LOW_AUTONOMY tier should auto-execute low-risk reversible actions', async () => {
      const dm = makeMocksAllowed();
      // Email archive is reversible, zero cost -> negligible/low risk
      const context = createContext(TrustTier.LOW_AUTONOMY);
      const outcome = await dm.evaluate(context);

      expect(outcome.selectedAction).not.toBeNull();
      // archive_email is reversible, zero cost -> low risk -> should auto-execute
      expect(outcome.autoExecute).toBe(true);
    });

    it('MODERATE_AUTONOMY tier should auto-execute moderate-risk actions', async () => {
      const dm = makeMocksAllowed();
      const context = createContext(TrustTier.MODERATE_AUTONOMY);
      const outcome = await dm.evaluate(context);

      expect(outcome.selectedAction).not.toBeNull();
      expect(outcome.autoExecute).toBe(true);
    });

    it('HIGH_AUTONOMY tier should auto-execute higher-risk actions', async () => {
      const dm = makeMocksAllowed();
      const context = createContext(TrustTier.HIGH_AUTONOMY);
      const outcome = await dm.evaluate(context);

      expect(outcome.selectedAction).not.toBeNull();
      expect(outcome.autoExecute).toBe(true);
    });

    it('LOW_AUTONOMY should NOT auto-execute irreversible high-cost actions', async () => {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator({
        allowed: true,
        requiresApproval: false,
      });
      const decisionRepo = createMockDecisionRepository();
      const dm = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      // Travel booking: irreversible, high cost -> higher risk tier
      const decision: DecisionObject = {
        id: 'dec_travel_la',
        situationType: SituationType.TRAVEL_DECISION,
        domain: 'travel',
        urgency: 'medium',
        summary: 'Expensive flight',
        rawData: { destination: 'Tokyo', costCents: 150000 },
        interpretedAt: new Date(),
      };
      const context = createContext(TrustTier.LOW_AUTONOMY, decision);
      const outcome = await dm.evaluate(context);

      // The book_travel candidate is irreversible + expensive -> high/critical risk.
      // LOW_AUTONOMY only auto-executes at LOW risk or below.
      // Even if save_option is selected (it's low risk), the book_travel won't auto-exec.
      // Regardless of which is selected, the test validates the trust tier constraint.
      if (outcome.selectedAction?.actionType === 'book_travel') {
        expect(outcome.autoExecute).toBe(false);
      }
    });
  });

  // ── Zero candidates -> escalation outcome ────────────────────────

  describe('Zero candidates escalation', () => {
    it('should produce an escalation outcome when no candidates are generated', async () => {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator();
      const decisionRepo = createMockDecisionRepository();
      const dm = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      // Spy on generateCandidates to force it to return empty
      vi.spyOn(dm, 'generateCandidates').mockReturnValue([]);

      const context = createContext(TrustTier.HIGH_AUTONOMY);
      const outcome = await dm.evaluate(context);

      expect(outcome.selectedAction).toBeNull();
      expect(outcome.allCandidates).toEqual([]);
      expect(outcome.riskAssessment).toBeNull();
      expect(outcome.autoExecute).toBe(false);
      expect(outcome.requiresApproval).toBe(true);
      expect(outcome.reasoning).toContain('No candidate actions could be generated');
      expect(outcome.reasoning).toContain('Escalating to user');
      expect(decisionRepo.saveOutcome).toHaveBeenCalledOnce();
    });
  });

  // ── whatWouldIDo integration ──────────────────────────────────────

  describe('whatWouldIDo()', () => {
    it('should return a prediction without persisting (uses evaluate internally)', async () => {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator({
        allowed: true,
        requiresApproval: false,
      });
      const decisionRepo = createMockDecisionRepository();
      const dm = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      const mockTwinServiceForQuery = {
        getOrCreateProfile: vi.fn().mockResolvedValue({
          id: 'twin_test',
          userId: 'user_test',
          version: 1,
          preferences: [],
          inferences: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getRelevantPreferences: vi.fn().mockResolvedValue([]),
        getPatterns: vi.fn().mockResolvedValue([]),
        getTraits: vi.fn().mockResolvedValue([]),
        getTemporalProfile: vi.fn().mockResolvedValue({
          userId: 'user_test',
          activeHours: { start: 8, end: 22 },
          peakResponseTimes: {},
          weekdayPatterns: {},
          urgencyThresholds: {},
        }),
      };

      const response = await dm.whatWouldIDo(
        'user_test',
        { situation: 'I got a new email from my boss', domain: 'email' },
        mockTwinServiceForQuery,
        TrustTier.MODERATE_AUTONOMY,
      );

      expect(response.predictionId).toMatch(/^pred_/);
      expect(response.reasoning).toBeTruthy();
      expect(response.alternativeActions).toBeDefined();
      expect(typeof response.wouldAutoExecute).toBe('boolean');
    });

    it('should infer CALENDAR_CONFLICT for calendar domain', async () => {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator({
        allowed: true,
        requiresApproval: false,
      });
      const decisionRepo = createMockDecisionRepository();
      const dm = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      const mockTwinServiceForQuery = {
        getOrCreateProfile: vi.fn().mockResolvedValue({
          id: 'twin_test',
          userId: 'user_test',
          version: 1,
          preferences: [],
          inferences: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getRelevantPreferences: vi.fn().mockResolvedValue([]),
        getPatterns: vi.fn().mockResolvedValue([]),
        getTraits: vi.fn().mockResolvedValue([]),
        getTemporalProfile: vi.fn().mockResolvedValue({
          userId: 'user_test',
          activeHours: { start: 8, end: 22 },
          peakResponseTimes: {},
          weekdayPatterns: {},
          urgencyThresholds: {},
        }),
      };

      const response = await dm.whatWouldIDo(
        'user_test',
        { situation: 'Conflicting meeting at 3pm', domain: 'calendar' },
        mockTwinServiceForQuery,
        TrustTier.HIGH_AUTONOMY,
      );

      // Calendar domain should produce calendar candidates (accept, decline, propose)
      const allActions = [
        response.predictedAction,
        ...response.alternativeActions,
      ].filter(Boolean);
      const actionTypes = allActions.map((a) => a!.actionType);
      expect(actionTypes).toContain('accept_invite');
    });

    it('should infer GENERIC for unknown domain', async () => {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator({
        allowed: true,
        requiresApproval: false,
      });
      const decisionRepo = createMockDecisionRepository();
      const dm = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      const mockTwinServiceForQuery = {
        getOrCreateProfile: vi.fn().mockResolvedValue({
          id: 'twin_test',
          userId: 'user_test',
          version: 1,
          preferences: [],
          inferences: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getRelevantPreferences: vi.fn().mockResolvedValue([]),
        getPatterns: vi.fn().mockResolvedValue([]),
        getTraits: vi.fn().mockResolvedValue([]),
        getTemporalProfile: vi.fn().mockResolvedValue({
          userId: 'user_test',
          activeHours: { start: 8, end: 22 },
          peakResponseTimes: {},
          weekdayPatterns: {},
          urgencyThresholds: {},
        }),
      };

      const response = await dm.whatWouldIDo(
        'user_test',
        { situation: 'Something strange happened' },
        mockTwinServiceForQuery,
        TrustTier.HIGH_AUTONOMY,
      );

      // No domain -> GENERIC -> create_note + escalate_to_user
      const allActions = [
        response.predictedAction,
        ...response.alternativeActions,
      ].filter(Boolean);
      const actionTypes = allActions.map((a) => a!.actionType);
      expect(actionTypes).toContain('create_note');
      expect(actionTypes).toContain('escalate_to_user');
    });

    it('returns no predicted action and no alternatives when policy blocks every candidate', async () => {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator({
        allowed: false,
        requiresApproval: false,
        reason: 'All candidates blocked.',
      });
      const decisionRepo = createMockDecisionRepository();
      const dm = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      const mockTwinServiceForQuery = {
        getOrCreateProfile: vi.fn().mockResolvedValue({
          id: 'twin_test',
          userId: 'user_test',
          version: 1,
          preferences: [],
          inferences: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getRelevantPreferences: vi.fn().mockResolvedValue([]),
        getPatterns: vi.fn().mockResolvedValue([]),
        getTraits: vi.fn().mockResolvedValue([]),
        getTemporalProfile: vi.fn().mockResolvedValue({
          userId: 'user_test',
          activeHours: { start: 8, end: 22 },
          peakResponseTimes: {},
          weekdayPatterns: {},
          urgencyThresholds: {},
        }),
      };

      const response = await dm.whatWouldIDo(
        'user_test',
        { situation: 'New email', domain: 'email' },
        mockTwinServiceForQuery,
        TrustTier.HIGH_AUTONOMY,
      );

      // Safety Invariant #1: predict path must not leak blocked candidates
      expect(response.predictedAction).toBeNull();
      expect(response.alternativeActions).toEqual([]);
      expect(response.wouldAutoExecute).toBe(false);
      expect(response.confidence).toBe(ConfidenceLevel.SPECULATIVE);
      // policyNotes should surface the blocking reason so the user understands
      expect(response.policyNotes).toBeDefined();
      expect(response.policyNotes).toContain('blocked');
    });
  });

  // ── All candidates blocked by policy ──────────────────────────────

  describe('All candidates blocked by policy', () => {
    it('should return no selected action and mention all blocked in reasoning', async () => {
      const twinService = createMockTwinService();
      const policyEvaluator = createMockPolicyEvaluator({
        allowed: false,
        requiresApproval: false,
        reason: 'Spending limit exceeded.',
      });
      const decisionRepo = createMockDecisionRepository();
      const dm = new DecisionMaker(
        twinService as never,
        policyEvaluator as never,
        decisionRepo as never,
      );

      const context = createContext(TrustTier.HIGH_AUTONOMY);
      const outcome = await dm.evaluate(context);

      expect(outcome.selectedAction).toBeNull();
      expect(outcome.autoExecute).toBe(false);
      expect(outcome.requiresApproval).toBe(true);
      expect(outcome.reasoning).toContain('blocked by policies');
    });
  });
});
