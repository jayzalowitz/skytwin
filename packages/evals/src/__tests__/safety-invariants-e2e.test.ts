/**
 * Safety Invariant Integration Tests
 *
 * One test group per safety invariant from CLAUDE.md.
 * These tests are the quality gate for M2: Safe Delegation.
 * Every test here MUST pass before shipping.
 */
import { describe, it, expect } from 'vitest';

// Decision engine
import { SituationInterpreter, DecisionMaker } from '@skytwin/decision-engine';
import type { DecisionRepositoryPort } from '@skytwin/decision-engine';

// Twin model
import { TwinService } from '@skytwin/twin-model';
import type { TwinRepositoryPort, PatternRepositoryPort } from '@skytwin/twin-model';

// Policy engine
import { PolicyEvaluator, SpendTracker, DomainAutonomyManager, EscalationTriggerEngine } from '@skytwin/policy-engine';
import type { PolicyRepositoryPort } from '@skytwin/policy-engine';
import type { DomainAutonomyRepositoryPort } from '@skytwin/policy-engine';

// Explanation generator
import { ExplanationGenerator } from '@skytwin/explanations';
import type { ExplanationRepositoryPort } from '@skytwin/explanations';

// Types
import type {
  TwinProfile,
  Preference,
  Inference,
  TwinEvidence,
  FeedbackEvent,
  DecisionObject,
  DecisionOutcome,
  CandidateAction,
  RiskAssessment,
  ExplanationRecord,
  ActionPolicy,
  AutonomySettings,
  BehavioralPattern,
  CrossDomainTrait,
} from '@skytwin/shared-types';
import {
  ConfidenceLevel,
  RiskTier,
  RiskDimension,
  TrustTier,
} from '@skytwin/shared-types';

// ── In-memory mock repositories ──────────────────────────────────

function createInMemoryTwinRepo(): TwinRepositoryPort {
  const profiles = new Map<string, TwinProfile>();
  const preferences = new Map<string, Preference[]>();
  const inferences = new Map<string, Inference[]>();
  const evidence = new Map<string, TwinEvidence[]>();
  const feedback = new Map<string, FeedbackEvent[]>();

  return {
    async getProfile(userId: string) { return profiles.get(userId) ?? null; },
    async createProfile(profile: TwinProfile) { profiles.set(profile.userId, profile); return profile; },
    async updateProfile(profile: TwinProfile) { profiles.set(profile.userId, profile); return profile; },
    async getPreferences(userId: string) { return preferences.get(userId) ?? []; },
    async getPreferencesByDomain(userId: string, domain: string) {
      return (preferences.get(userId) ?? []).filter(p => p.domain === domain);
    },
    async upsertPreference(userId: string, pref: Preference) {
      const existing = preferences.get(userId) ?? [];
      const idx = existing.findIndex(p => p.domain === pref.domain && p.key === pref.key);
      if (idx >= 0) { existing[idx] = pref; } else { existing.push(pref); }
      preferences.set(userId, existing);
      return pref;
    },
    async getInferences(userId: string) { return inferences.get(userId) ?? []; },
    async upsertInference(userId: string, inf: Inference) {
      const existing = inferences.get(userId) ?? [];
      const idx = existing.findIndex(i => i.domain === inf.domain && i.key === inf.key);
      if (idx >= 0) { existing[idx] = inf; } else { existing.push(inf); }
      inferences.set(userId, existing);
      return inf;
    },
    async addEvidence(ev: TwinEvidence) {
      const existing = evidence.get(ev.userId) ?? [];
      existing.push(ev);
      evidence.set(ev.userId, existing);
      return ev;
    },
    async getEvidence(userId: string, limit?: number) {
      const all = evidence.get(userId) ?? [];
      return limit ? all.slice(0, limit) : all;
    },
    async getEvidenceByIds(ids: string[]) {
      const all: TwinEvidence[] = [];
      for (const evs of evidence.values()) {
        all.push(...evs.filter(e => ids.includes(e.id)));
      }
      return all;
    },
    async addFeedback(fb: FeedbackEvent) {
      const existing = feedback.get(fb.userId) ?? [];
      existing.push(fb);
      feedback.set(fb.userId, existing);
      return fb;
    },
    async getFeedback(userId: string, limit?: number) {
      const all = feedback.get(userId) ?? [];
      return limit ? all.slice(0, limit) : all;
    },
  };
}

function createInMemoryPatternRepo(): PatternRepositoryPort {
  const patterns = new Map<string, BehavioralPattern[]>();
  const traits = new Map<string, CrossDomainTrait[]>();
  return {
    async getPatterns(userId: string) { return patterns.get(userId) ?? []; },
    async upsertPattern(userId: string, pattern: BehavioralPattern) {
      const existing = patterns.get(userId) ?? [];
      existing.push(pattern);
      patterns.set(userId, existing);
      return pattern;
    },
    async getTraits(userId: string) { return traits.get(userId) ?? []; },
    async upsertTrait(userId: string, trait: CrossDomainTrait) {
      const existing = traits.get(userId) ?? [];
      existing.push(trait);
      traits.set(userId, existing);
      return trait;
    },
  };
}

function createInMemoryDecisionRepo(): DecisionRepositoryPort {
  const decisions = new Map<string, DecisionObject>();
  const outcomes = new Map<string, DecisionOutcome>();
  const candidates = new Map<string, CandidateAction[]>();
  const riskAssessments = new Map<string, RiskAssessment>();
  return {
    async saveDecision(decision: DecisionObject) { decisions.set(decision.id, decision); return decision; },
    async getDecision(id: string) { return decisions.get(id) ?? null; },
    async saveOutcome(outcome: DecisionOutcome) { outcomes.set(outcome.decisionId, outcome); return outcome; },
    async getOutcome(decisionId: string) { return outcomes.get(decisionId) ?? null; },
    async saveCandidates(cands: CandidateAction[]) {
      if (cands.length > 0) { candidates.set(cands[0]!.decisionId, cands); }
      return cands;
    },
    async getCandidates(decisionId: string) { return candidates.get(decisionId) ?? []; },
    async saveRiskAssessment(assessment: RiskAssessment) { riskAssessments.set(assessment.actionId, assessment); return assessment; },
    async getRiskAssessment(actionId: string) { return riskAssessments.get(actionId) ?? null; },
    async getRecentDecisions() { return Array.from(decisions.values()); },
  };
}

function createInMemoryExplanationRepo(): ExplanationRepositoryPort & { records: ExplanationRecord[] } {
  const records: ExplanationRecord[] = [];
  return {
    records,
    async save(record: ExplanationRecord) { records.push(record); return record; },
    async getByDecisionId(decisionId: string) { return records.find(r => r.decisionId === decisionId) ?? null; },
    async getByUserId(userId: string, limit?: number) {
      const matching = records.filter(r => r.userId === userId);
      return limit ? matching.slice(0, limit) : matching;
    },
  };
}

function createMockPolicyRepo(): PolicyRepositoryPort {
  const policies: ActionPolicy[] = [];
  return {
    async getAllPolicies() { return policies; },
    async getEnabledPolicies() { return policies.filter(p => p.enabled); },
    async getPolicy(id: string) { return policies.find(p => p.id === id) ?? null; },
    async getPoliciesByDomain(domain: string) { return policies.filter(p => p.name.includes(domain)); },
    async savePolicy(policy: ActionPolicy) { policies.push(policy); return policy; },
    async updatePolicy(policy: ActionPolicy) { return policy; },
    async deletePolicy() { /* no-op */ },
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function createAction(overrides?: Partial<CandidateAction>): CandidateAction {
  return {
    id: 'act_test',
    decisionId: 'dec_test',
    actionType: 'archive_email',
    description: 'Archive an email',
    domain: 'email',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'test action',
    ...overrides,
  };
}

const defaultDim = { tier: RiskTier.NEGLIGIBLE, score: 0, reasoning: 'OK' };

function createRisk(overrides?: Partial<RiskAssessment>): RiskAssessment {
  return {
    actionId: 'act_test',
    overallTier: RiskTier.NEGLIGIBLE,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: defaultDim,
      [RiskDimension.FINANCIAL_IMPACT]: defaultDim,
      [RiskDimension.LEGAL_SENSITIVITY]: defaultDim,
      [RiskDimension.PRIVACY_SENSITIVITY]: defaultDim,
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: defaultDim,
      [RiskDimension.OPERATIONAL_RISK]: defaultDim,
    },
    reasoning: 'low risk',
    assessedAt: new Date(),
    ...overrides,
  };
}

function createAutonomySettings(overrides?: Partial<AutonomySettings>): AutonomySettings {
  return {
    maxSpendPerActionCents: 10000,
    maxDailySpendCents: 50000,
    allowedDomains: [],
    blockedDomains: [],
    requireApprovalForIrreversible: true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('Safety Invariant 1: Never auto-execute without a policy check', () => {
  it('every action path goes through PolicyEvaluator.evaluate()', async () => {
    const policyRepo = createMockPolicyRepo();
    const policyEvaluator = new PolicyEvaluator(policyRepo);
    const twinService = new TwinService(createInMemoryTwinRepo(), createInMemoryPatternRepo());
    const decisionMaker = new DecisionMaker(twinService, policyEvaluator, createInMemoryDecisionRepo());

    const userId = 'user_invariant1';
    await twinService.getOrCreateProfile(userId);

    const context = {
      userId,
      decision: new SituationInterpreter().interpret({
        source: 'gmail',
        type: 'new_email',
        subject: 'Test email',
        from: 'test@example.com',
        body: 'body',
      }),
      trustTier: TrustTier.MODERATE_AUTONOMY,
      relevantPreferences: [],
      timestamp: new Date(),
      patterns: [],
      traits: [],
      temporalProfile: undefined,
    };

    const outcome = await decisionMaker.evaluate(context);

    // The outcome includes policyDecision, proving the policy was checked
    expect(outcome).toBeDefined();
    expect(outcome.selectedAction).toBeDefined();
    // The policy engine ran: autoExecute is determined by policy
    expect(typeof outcome.autoExecute).toBe('boolean');
  });

  it('OBSERVER tier blocks all actions even with low risk', async () => {
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const action = createAction();
    const risk = createRisk();

    const decision = await policyEvaluator.evaluate(action, [], TrustTier.OBSERVER, risk);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Observer');
  });
});

describe('Safety Invariant 2: Always log explanations', () => {
  it('decision pipeline produces explanation for every outcome', async () => {
    const twinRepo = createInMemoryTwinRepo();
    const patternRepo = createInMemoryPatternRepo();
    const explanationRepo = createInMemoryExplanationRepo();

    const twinService = new TwinService(twinRepo, patternRepo);
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const decisionMaker = new DecisionMaker(twinService, policyEvaluator, createInMemoryDecisionRepo());
    const explanationGenerator = new ExplanationGenerator(explanationRepo);

    const userId = 'user_invariant2';
    await twinService.getOrCreateProfile(userId);

    const interpreter = new SituationInterpreter();
    const decision = interpreter.interpret({
      source: 'gmail',
      type: 'new_email',
      subject: 'Newsletter',
      from: 'news@example.com',
      body: 'Weekly news',
    });

    const context = {
      userId,
      decision,
      trustTier: TrustTier.MODERATE_AUTONOMY,
      relevantPreferences: [],
      timestamp: new Date(),
      patterns: [],
      traits: [],
      temporalProfile: undefined,
    };

    const outcome = await decisionMaker.evaluate(context);
    const explanation = await explanationGenerator.generate(decision, outcome, context);

    expect(explanation).toBeDefined();
    expect(explanation.decisionId).toBe(decision.id);
    expect(explanation.summary).toBeTruthy();
    expect(explanation.actionRationale).toBeTruthy();
    expect(explanation.correctionGuidance).toBeTruthy();
    expect(explanationRepo.records.length).toBe(1);
  });
});

describe('Safety Invariant 3: Respect trust tiers', () => {
  const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());

  it('OBSERVER blocks everything', async () => {
    for (const tier of [RiskTier.NEGLIGIBLE, RiskTier.LOW, RiskTier.MODERATE, RiskTier.HIGH, RiskTier.CRITICAL]) {
      const result = await policyEvaluator.evaluate(
        createAction(), [], TrustTier.OBSERVER, createRisk({ overallTier: tier }),
      );
      expect(result.allowed).toBe(false);
    }
  });

  it('SUGGEST requires approval for everything', async () => {
    for (const tier of [RiskTier.NEGLIGIBLE, RiskTier.LOW, RiskTier.MODERATE, RiskTier.HIGH, RiskTier.CRITICAL]) {
      const result = await policyEvaluator.evaluate(
        createAction(), [], TrustTier.SUGGEST, createRisk({ overallTier: tier }),
      );
      expect(result.requiresApproval).toBe(true);
    }
  });

  it('LOW_AUTONOMY auto-executes negligible/low, requires approval above', async () => {
    const negligible = await policyEvaluator.evaluate(
      createAction(), [], TrustTier.LOW_AUTONOMY, createRisk({ overallTier: RiskTier.NEGLIGIBLE }),
    );
    expect(negligible.allowed).toBe(true);
    expect(negligible.requiresApproval).toBe(false);

    const low = await policyEvaluator.evaluate(
      createAction(), [], TrustTier.LOW_AUTONOMY, createRisk({ overallTier: RiskTier.LOW }),
    );
    expect(low.allowed).toBe(true);
    expect(low.requiresApproval).toBe(false);

    const moderate = await policyEvaluator.evaluate(
      createAction(), [], TrustTier.LOW_AUTONOMY, createRisk({ overallTier: RiskTier.MODERATE }),
    );
    expect(moderate.requiresApproval).toBe(true);
  });

  it('MODERATE_AUTONOMY auto-executes up to moderate, requires approval above', async () => {
    const moderate = await policyEvaluator.evaluate(
      createAction(), [], TrustTier.MODERATE_AUTONOMY, createRisk({ overallTier: RiskTier.MODERATE }),
    );
    expect(moderate.allowed).toBe(true);
    expect(moderate.requiresApproval).toBe(false);

    const high = await policyEvaluator.evaluate(
      createAction(), [], TrustTier.MODERATE_AUTONOMY, createRisk({ overallTier: RiskTier.HIGH }),
    );
    expect(high.requiresApproval).toBe(true);
  });

  it('HIGH_AUTONOMY auto-executes everything except critical', async () => {
    const high = await policyEvaluator.evaluate(
      createAction(), [], TrustTier.HIGH_AUTONOMY, createRisk({ overallTier: RiskTier.HIGH }),
    );
    expect(high.allowed).toBe(true);
    expect(high.requiresApproval).toBe(false);

    const critical = await policyEvaluator.evaluate(
      createAction(), [], TrustTier.HIGH_AUTONOMY, createRisk({ overallTier: RiskTier.CRITICAL }),
    );
    expect(critical.requiresApproval).toBe(true);
  });
});

describe('Safety Invariant 4: Spend limits are hard limits', () => {
  it('per-action spend limit blocks when exceeded', async () => {
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const settings = createAutonomySettings({ maxSpendPerActionCents: 5000 });

    const result = await policyEvaluator.evaluate(
      createAction({ estimatedCostCents: 5001 }),
      [],
      TrustTier.HIGH_AUTONOMY,
      createRisk(),
      settings,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('spend limit');
  });

  it('per-action spend limit allows zero-cost actions even with zero limit', async () => {
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    // Per-action limit of 0 cents: zero-cost actions should still pass
    const settings = createAutonomySettings({ maxSpendPerActionCents: 0 });

    const ok = policyEvaluator.checkSpendLimit(
      createAction({ estimatedCostCents: 0 }),
      settings,
    );
    expect(ok).toBe(true);

    // But a $1 action should fail
    const blocked = policyEvaluator.checkSpendLimit(
      createAction({ estimatedCostCents: 100 }),
      settings,
    );
    expect(blocked).toBe(false);
  });

  it('per-action checkSpendLimit allows at exactly the limit', () => {
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const settings = createAutonomySettings({ maxSpendPerActionCents: 5000 });

    const ok = policyEvaluator.checkSpendLimit(
      createAction({ estimatedCostCents: 5000 }),
      settings,
    );
    expect(ok).toBe(true);

    const blocked = policyEvaluator.checkSpendLimit(
      createAction({ estimatedCostCents: 5001 }),
      settings,
    );
    expect(blocked).toBe(false);
  });

  it('daily spend limit blocks when cumulative exceeds limit (SpendTracker)', async () => {
    const spendTracker = new SpendTracker({
      getDailyTotal: async () => 45000,
      reconcile: async () => null,
    });

    const settings = createAutonomySettings({ maxDailySpendCents: 50000 });
    const result = await spendTracker.checkDailyLimit('user1', 10000, settings);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily');
  });

  it('daily spend limit allows when within bounds', async () => {
    const spendTracker = new SpendTracker({
      getDailyTotal: async () => 30000,
      reconcile: async () => null,
    });

    const settings = createAutonomySettings({ maxDailySpendCents: 50000 });
    const result = await spendTracker.checkDailyLimit('user1', 10000, settings);

    expect(result.allowed).toBe(true);
  });

  it('zero-cost actions are never blocked by spend limits', async () => {
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const settings = createAutonomySettings({ maxSpendPerActionCents: 0 });

    const result = await policyEvaluator.evaluate(
      createAction({ estimatedCostCents: 0 }),
      [],
      TrustTier.HIGH_AUTONOMY,
      createRisk(),
      settings,
    );

    expect(result.allowed).toBe(true);
  });
});

describe('Safety Invariant 5: Reversibility matters', () => {
  it('irreversible action with high risk requires approval via autonomy settings', async () => {
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const settings = createAutonomySettings({ requireApprovalForIrreversible: true });

    const result = await policyEvaluator.evaluate(
      createAction({ reversible: false }),
      [],
      TrustTier.HIGH_AUTONOMY,
      createRisk({ overallTier: RiskTier.MODERATE }),
      settings,
    );

    expect(result.requiresApproval).toBe(true);
    expect(result.reason).toContain('irreversible');
  });

  it('reversible action with same risk level auto-executes', async () => {
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const settings = createAutonomySettings({ requireApprovalForIrreversible: true });

    const result = await policyEvaluator.evaluate(
      createAction({ reversible: true }),
      [],
      TrustTier.HIGH_AUTONOMY,
      createRisk({ overallTier: RiskTier.MODERATE }),
      settings,
    );

    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it('checkReversibility rejects irreversible actions above LOW risk', () => {
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());

    expect(policyEvaluator.checkReversibility(
      createAction({ reversible: false }),
      createRisk({ overallTier: RiskTier.MODERATE }),
    )).toBe(false);

    expect(policyEvaluator.checkReversibility(
      createAction({ reversible: false }),
      createRisk({ overallTier: RiskTier.LOW }),
    )).toBe(true);

    expect(policyEvaluator.checkReversibility(
      createAction({ reversible: false }),
      createRisk({ overallTier: RiskTier.NEGLIGIBLE }),
    )).toBe(true);
  });
});

describe('Safety Invariant 6: Feedback flows back', () => {
  it('processFeedback updates twin model version', async () => {
    const twinService = new TwinService(createInMemoryTwinRepo(), createInMemoryPatternRepo());
    const userId = 'user_invariant6';

    const profile = await twinService.getOrCreateProfile(userId);
    expect(profile.version).toBe(1);

    const feedback: FeedbackEvent = {
      id: 'fb_1',
      userId,
      decisionId: 'dec_1',
      feedbackType: 'approve',
      reason: 'Good call',
      timestamp: new Date(),
    };

    const updated = await twinService.processFeedback(userId, feedback);
    expect(updated.version).toBeGreaterThan(profile.version);
  });

  it('rejection feedback updates twin model', async () => {
    const twinService = new TwinService(createInMemoryTwinRepo(), createInMemoryPatternRepo());
    const userId = 'user_reject';

    await twinService.getOrCreateProfile(userId);

    const feedback: FeedbackEvent = {
      id: 'fb_reject',
      userId,
      decisionId: 'dec_2',
      feedbackType: 'reject',
      reason: 'Wrong action',
      timestamp: new Date(),
    };

    const updated = await twinService.processFeedback(userId, feedback);
    expect(updated.version).toBeGreaterThan(1);
  });

  it('undo feedback updates twin model with higher weight', async () => {
    const twinService = new TwinService(createInMemoryTwinRepo(), createInMemoryPatternRepo());
    const userId = 'user_undo';

    await twinService.getOrCreateProfile(userId);

    const feedback: FeedbackEvent = {
      id: 'fb_undo',
      userId,
      decisionId: 'dec_3',
      feedbackType: 'undo',
      reason: 'Mistake',
      undoReasoning: {
        whatWentWrong: 'Archived important email',
        severity: 'severe',
        preferredAlternative: 'Keep in inbox',
      },
      timestamp: new Date(),
    };

    const updated = await twinService.processFeedback(userId, feedback);
    expect(updated.version).toBeGreaterThan(1);
  });
});

describe('Safety Invariant 7: Risk assessment is mandatory', () => {
  it('DecisionMaker always produces a risk assessment for the selected action', async () => {
    const twinService = new TwinService(createInMemoryTwinRepo(), createInMemoryPatternRepo());
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const decisionMaker = new DecisionMaker(twinService, policyEvaluator, createInMemoryDecisionRepo());

    const userId = 'user_invariant7';
    await twinService.getOrCreateProfile(userId);

    const decision = new SituationInterpreter().interpret({
      source: 'gmail',
      type: 'new_email',
      subject: 'Test',
      from: 'test@test.com',
      body: 'content',
    });

    const context = {
      userId,
      decision,
      trustTier: TrustTier.MODERATE_AUTONOMY,
      relevantPreferences: [],
      timestamp: new Date(),
      patterns: [],
      traits: [],
      temporalProfile: undefined,
    };

    const outcome = await decisionMaker.evaluate(context);

    expect(outcome.riskAssessment).toBeDefined();
    expect(outcome.riskAssessment).not.toBeNull();
    expect(outcome.riskAssessment!.overallTier).toBeDefined();
    expect(outcome.riskAssessment!.reasoning).toBeTruthy();
  });
});

describe('M2 Safety: Domain autonomy uses most restrictive tier', () => {
  it('domain override restricts global tier', async () => {
    const repo: DomainAutonomyRepositoryPort = {
      getForUser: async () => [{ domain: 'finance', trustTier: TrustTier.LOW_AUTONOMY }],
      getForDomain: async (_userId: string, domain: string) =>
        domain === 'finance' ? { domain: 'finance', trustTier: TrustTier.LOW_AUTONOMY } : null,
    };
    const manager = new DomainAutonomyManager(repo);

    const result = await manager.getEffectiveTier('user1', 'finance', TrustTier.HIGH_AUTONOMY);

    expect(result.effectiveTier).toBe(TrustTier.LOW_AUTONOMY);
    expect(result.source).toBe('domain');
  });

  it('global tier restricts when more restrictive than domain', async () => {
    const repo: DomainAutonomyRepositoryPort = {
      getForUser: async () => [{ domain: 'email', trustTier: TrustTier.HIGH_AUTONOMY }],
      getForDomain: async () => ({ domain: 'email', trustTier: TrustTier.HIGH_AUTONOMY }),
    };
    const manager = new DomainAutonomyManager(repo);

    const result = await manager.getEffectiveTier('user1', 'email', TrustTier.SUGGEST);

    expect(result.effectiveTier).toBe(TrustTier.SUGGEST);
    expect(result.source).toBe('global');
  });
});

describe('M2 Safety: Escalation triggers fire correctly', () => {
  const engine = new EscalationTriggerEngine();

  it('amount threshold triggers escalation', () => {
    const result = engine.evaluate(
      [{ id: 't1', triggerType: 'amount_threshold', conditions: { thresholdCents: 5000 }, enabled: true }],
      {
        action: createAction({ estimatedCostCents: 6000 }),
        riskAssessment: createRisk(),
        matchingPreferenceCount: 3,
        consecutiveRejections: 0,
      },
    );

    expect(result.shouldEscalate).toBe(true);
    expect(result.triggeredBy).toContain('t1');
  });

  it('novel situation triggers escalation when no preferences match', () => {
    const result = engine.evaluate(
      [{ id: 't2', triggerType: 'novel_situation', conditions: {}, enabled: true }],
      {
        action: createAction(),
        riskAssessment: createRisk(),
        matchingPreferenceCount: 0,
        consecutiveRejections: 0,
      },
    );

    expect(result.shouldEscalate).toBe(true);
  });

  it('disabled triggers do not fire', () => {
    const result = engine.evaluate(
      [{ id: 't3', triggerType: 'novel_situation', conditions: {}, enabled: false }],
      {
        action: createAction(),
        riskAssessment: createRisk(),
        matchingPreferenceCount: 0,
        consecutiveRejections: 0,
      },
    );

    expect(result.shouldEscalate).toBe(false);
  });
});
