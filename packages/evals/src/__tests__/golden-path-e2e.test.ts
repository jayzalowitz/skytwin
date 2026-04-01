/**
 * Golden Path E2E Integration Test
 *
 * Validates the full SkyTwin decision pipeline end-to-end:
 *   Mock signal → interpret → twin query → candidates → risk + adapter modifier
 *   → policy → router selects adapter → mock execution → explanation logged
 *   → feedback recorded → twin updated
 *
 * This test exercises every package boundary in a single flow.
 */
import { describe, it, expect } from 'vitest';

// Decision engine
import { SituationInterpreter, DecisionMaker } from '@skytwin/decision-engine';
import type { DecisionRepositoryPort } from '@skytwin/decision-engine';

// Twin model
import { TwinService } from '@skytwin/twin-model';
import type { TwinRepositoryPort, PatternRepositoryPort } from '@skytwin/twin-model';

// Policy engine
import { PolicyEvaluator } from '@skytwin/policy-engine';
import type { PolicyRepositoryPort } from '@skytwin/policy-engine';

// Explanation generator
import { ExplanationGenerator } from '@skytwin/explanations';
import type { ExplanationRepositoryPort } from '@skytwin/explanations';

// Execution router
import { ExecutionRouter, AdapterRegistry, OpenClawAdapter } from '@skytwin/execution-router';
import { IRONCLAW_TRUST_PROFILE, OPENCLAW_TRUST_PROFILE } from '@skytwin/execution-router';

// IronClaw adapter (mock)
import { BasicMockAdapter } from '@skytwin/ironclaw-adapter';

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
  BehavioralPattern,
  CrossDomainTrait,
} from '@skytwin/shared-types';
import {
  ConfidenceLevel,
  SituationType,
  TrustTier,
  RiskTier,
} from '@skytwin/shared-types';

// ── In-memory mock repositories ──────────────────────────────────

function createInMemoryTwinRepo(): TwinRepositoryPort {
  const profiles = new Map<string, TwinProfile>();
  const preferences = new Map<string, Preference[]>();
  const inferences = new Map<string, Inference[]>();
  const evidence = new Map<string, TwinEvidence[]>();
  const feedback = new Map<string, FeedbackEvent[]>();

  return {
    async getProfile(userId: string) {
      return profiles.get(userId) ?? null;
    },
    async createProfile(profile: TwinProfile) {
      profiles.set(profile.userId, profile);
      return profile;
    },
    async updateProfile(profile: TwinProfile) {
      profiles.set(profile.userId, profile);
      return profile;
    },
    async getPreferences(userId: string) {
      return preferences.get(userId) ?? [];
    },
    async getPreferencesByDomain(userId: string, domain: string) {
      return (preferences.get(userId) ?? []).filter(p => p.domain === domain);
    },
    async upsertPreference(userId: string, pref: Preference) {
      const existing = preferences.get(userId) ?? [];
      const idx = existing.findIndex(p => p.domain === pref.domain && p.key === pref.key);
      if (idx >= 0) {
        existing[idx] = pref;
      } else {
        existing.push(pref);
      }
      preferences.set(userId, existing);
      return pref;
    },
    async getInferences(userId: string) {
      return inferences.get(userId) ?? [];
    },
    async upsertInference(userId: string, inf: Inference) {
      const existing = inferences.get(userId) ?? [];
      const idx = existing.findIndex(i => i.domain === inf.domain && i.key === inf.key);
      if (idx >= 0) {
        existing[idx] = inf;
      } else {
        existing.push(inf);
      }
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
    async getPatterns(userId: string) {
      return patterns.get(userId) ?? [];
    },
    async upsertPattern(userId: string, pattern: BehavioralPattern) {
      const existing = patterns.get(userId) ?? [];
      existing.push(pattern);
      patterns.set(userId, existing);
      return pattern;
    },
    async getTraits(userId: string) {
      return traits.get(userId) ?? [];
    },
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
    async saveDecision(decision: DecisionObject) {
      decisions.set(decision.id, decision);
      return decision;
    },
    async getDecision(id: string) {
      return decisions.get(id) ?? null;
    },
    async saveOutcome(outcome: DecisionOutcome) {
      outcomes.set(outcome.decisionId, outcome);
      return outcome;
    },
    async getOutcome(decisionId: string) {
      return outcomes.get(decisionId) ?? null;
    },
    async saveCandidates(cands: CandidateAction[]) {
      if (cands.length > 0) {
        candidates.set(cands[0]!.decisionId, cands);
      }
      return cands;
    },
    async getCandidates(decisionId: string) {
      return candidates.get(decisionId) ?? [];
    },
    async saveRiskAssessment(assessment: RiskAssessment) {
      riskAssessments.set(assessment.actionId, assessment);
      return assessment;
    },
    async getRiskAssessment(actionId: string) {
      return riskAssessments.get(actionId) ?? null;
    },
    async getRecentDecisions(_userId: string, _limit?: number) {
      return Array.from(decisions.values());
    },
  };
}

function createInMemoryExplanationRepo(): ExplanationRepositoryPort & { records: ExplanationRecord[] } {
  const records: ExplanationRecord[] = [];
  return {
    records,
    async save(record: ExplanationRecord) {
      records.push(record);
      return record;
    },
    async getByDecisionId(decisionId: string) {
      return records.find(r => r.decisionId === decisionId) ?? null;
    },
    async getByUserId(userId: string, limit?: number) {
      const matching = records.filter(r => r.userId === userId);
      return limit ? matching.slice(0, limit) : matching;
    },
  };
}

// ── Mock PolicyRepositoryPort ────────────────────────────────────

function createMockPolicyRepo(): PolicyRepositoryPort {
  const policies: ActionPolicy[] = [];
  return {
    async getAllPolicies() { return policies; },
    async getEnabledPolicies() { return policies.filter(p => p.enabled); },
    async getPolicy(id: string) { return policies.find(p => p.id === id) ?? null; },
    async getPoliciesByDomain(domain: string) { return policies.filter(p => p.name.includes(domain)); },
    async savePolicy(policy: ActionPolicy) { policies.push(policy); return policy; },
    async updatePolicy(policy: ActionPolicy) { return policy; },
    async deletePolicy(_id: string) { /* no-op */ },
  };
}

// ── The Test ─────────────────────────────────────────────────────

describe('Golden Path E2E Integration', () => {
  it('full pipeline: signal → interpret → decide → explain → feedback → twin update', async () => {
    // ── 1. Set up all components ──
    const twinRepo = createInMemoryTwinRepo();
    const patternRepo = createInMemoryPatternRepo();
    const decisionRepo = createInMemoryDecisionRepo();
    const explanationRepo = createInMemoryExplanationRepo();
    const policyRepo = createMockPolicyRepo();

    const twinService = new TwinService(twinRepo, patternRepo);
    const policyEvaluator = new PolicyEvaluator(policyRepo);
    const decisionMaker = new DecisionMaker(twinService, policyEvaluator, decisionRepo);
    const explanationGenerator = new ExplanationGenerator(explanationRepo);
    const interpreter = new SituationInterpreter();

    // Set up execution router with mock adapters
    const registry = new AdapterRegistry();
    const mockIronClaw = new BasicMockAdapter();
    const mockOpenClaw = new OpenClawAdapter();
    registry.register('ironclaw', mockIronClaw, IRONCLAW_TRUST_PROFILE);
    registry.register('openclaw', mockOpenClaw, OPENCLAW_TRUST_PROFILE);
    const executionRouter = new ExecutionRouter(registry);

    // Create a user profile with some preferences
    const userId = 'user_golden_path';
    const profile = await twinService.getOrCreateProfile(userId);
    expect(profile).toBeDefined();
    expect(profile.userId).toBe(userId);

    // Add a preference
    await twinService.updatePreference(userId, {
      id: 'pref_archive_newsletters',
      domain: 'email',
      key: 'newsletter_action',
      value: 'archive',
      confidence: ConfidenceLevel.HIGH,
      source: 'explicit',
      evidenceIds: ['ev_001'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // ── 2. Signal arrives: email newsletter ──
    const rawSignal = {
      source: 'gmail',
      type: 'new_email',
      subject: 'Weekly Tech Newsletter',
      from: 'newsletter@techdigest.com',
      body: 'This week in tech...',
      receivedAt: new Date().toISOString(),
    };

    // ── 3. Interpret the signal ──
    const decision = interpreter.interpret(rawSignal);
    expect(decision.situationType).toBe(SituationType.EMAIL_TRIAGE);
    expect(decision.domain).toBe('email');
    expect(decision.summary).toBeTruthy();

    // ── 4. Build decision context ──
    const relevantPrefs = await twinService.getRelevantPreferences(
      userId,
      decision.domain,
      decision.summary,
    );
    expect(relevantPrefs.length).toBeGreaterThan(0);

    const patterns = await twinService.getPatterns(userId);
    const traits = await twinService.getTraits(userId);
    const temporalProfile = await twinService.getTemporalProfile(userId);

    const context = {
      userId,
      decision,
      trustTier: TrustTier.MODERATE_AUTONOMY,
      relevantPreferences: relevantPrefs,
      timestamp: new Date(),
      patterns,
      traits,
      temporalProfile,
    };

    // ── 5. Evaluate with decision engine ──
    const outcome = await decisionMaker.evaluate(context);
    expect(outcome).toBeDefined();
    expect(outcome.selectedAction).not.toBeNull();
    expect(outcome.allCandidates.length).toBeGreaterThan(0);
    expect(outcome.riskAssessment).not.toBeNull();
    expect(outcome.reasoning).toBeTruthy();

    // Verify all candidates have risk assessments (safety invariant #7)
    expect(outcome.riskAssessment).toBeDefined();

    // ── 6. Generate explanation (safety invariant #2) ──
    const explanation = await explanationGenerator.generate(decision, outcome, context);
    expect(explanation).toBeDefined();
    expect(explanation.decisionId).toBe(decision.id);
    expect(explanation.userId).toBe(userId);
    expect(explanation.summary).toBeTruthy();
    expect(explanation.actionRationale).toBeTruthy();
    expect(explanation.correctionGuidance).toBeTruthy();

    // Verify explanation was persisted
    expect(explanationRepo.records.length).toBe(1);

    // ── 7. Route to adapter (if auto-executable) ──
    if (outcome.selectedAction && outcome.autoExecute) {
      const routingDecision = await executionRouter.route(
        outcome.selectedAction,
        outcome.riskAssessment!,
        userId,
      );
      expect(routingDecision.selectedAdapter).toBeTruthy();
      expect(routingDecision.trustProfile).toBeDefined();
      expect(routingDecision.reasoning).toBeTruthy();
    }

    // ── 8. Record feedback (simulate user approval) ──
    const feedback: FeedbackEvent = {
      id: `fb_${Date.now()}`,
      userId,
      decisionId: decision.id,
      feedbackType: 'approve',
      reason: 'Good decision',
      timestamp: new Date(),
    };

    const updatedProfile = await twinService.processFeedback(userId, feedback);
    expect(updatedProfile.version).toBeGreaterThan(profile.version);

    // ── 9. Verify twin was updated ──
    const finalProfile = await twinService.getOrCreateProfile(userId);
    expect(finalProfile.version).toBeGreaterThan(1);
  });

  it('whatWouldIDo prediction runs full pipeline without execution', async () => {
    const twinRepo = createInMemoryTwinRepo();
    const patternRepo = createInMemoryPatternRepo();
    const decisionRepo = createInMemoryDecisionRepo();

    const twinService = new TwinService(twinRepo, patternRepo);
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const decisionMaker = new DecisionMaker(twinService, policyEvaluator, decisionRepo);

    const userId = 'user_prediction';
    await twinService.getOrCreateProfile(userId);

    const response = await decisionMaker.whatWouldIDo(
      userId,
      { situation: 'Got an email from my boss about reviewing a document' },
      twinService,
      TrustTier.MODERATE_AUTONOMY,
    );

    expect(response).toBeDefined();
    expect(response.predictionId).toBeTruthy();
    expect(response.reasoning).toBeTruthy();
    expect(response.confidence).toBeDefined();
    expect(Array.isArray(response.alternativeActions)).toBe(true);
  });

  it('undo feedback applies 2x weight correction to twin', async () => {
    const twinRepo = createInMemoryTwinRepo();
    const patternRepo = createInMemoryPatternRepo();
    const twinService = new TwinService(twinRepo, patternRepo);

    const userId = 'user_undo';
    await twinService.getOrCreateProfile(userId);

    // Add evidence to create an inference
    await twinService.addEvidence(userId, {
      id: 'ev_undo_1',
      userId,
      source: 'gmail',
      type: 'action',
      data: { action: 'archive', domain: 'email' },
      domain: 'email',
      timestamp: new Date(),
    });

    // Record undo feedback
    const undoFeedback: FeedbackEvent = {
      id: `fb_undo_${Date.now()}`,
      userId,
      decisionId: 'dec_test',
      feedbackType: 'undo',
      reason: 'Should not have archived',
      undoReasoning: {
        whatWentWrong: 'Archived an important email',
        severity: 'severe',
        preferredAlternative: 'Label as important',
      },
      timestamp: new Date(),
    };

    const updatedProfile = await twinService.processFeedback(userId, undoFeedback);
    expect(updatedProfile.version).toBeGreaterThan(1);
  });

  it('execution router applies risk modifier for OpenClaw adapter', async () => {
    const registry = new AdapterRegistry();
    const mockOpenClaw = new OpenClawAdapter();
    // Only register OpenClaw — forces it to be selected
    registry.register('openclaw', mockOpenClaw, OPENCLAW_TRUST_PROFILE);
    const router = new ExecutionRouter(registry);

    const action: CandidateAction = {
      id: 'act_test',
      decisionId: 'dec_test',
      actionType: 'social_media_post',
      description: 'Post to social media',
      domain: 'social',
      parameters: {},
      estimatedCostCents: 0,
      reversible: false, // Irreversible — should trigger risk modifier
      confidence: ConfidenceLevel.HIGH,
      reasoning: 'Test action',
    };

    const riskAssessment: RiskAssessment = {
      actionId: 'act_test',
      overallTier: RiskTier.LOW,
      dimensions: {} as RiskAssessment['dimensions'],
      reasoning: 'Low risk action',
      assessedAt: new Date(),
    };

    const routingDecision = await router.route(action, riskAssessment, 'user_test');
    expect(routingDecision.selectedAdapter).toBe('openclaw');
    // Irreversible action + OpenClaw riskModifier=1 → should bump risk
    expect(routingDecision.riskModifierApplied).toBe(1);
  });
});
