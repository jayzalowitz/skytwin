/**
 * Subscription Renewal E2E Integration Test
 */
import { describe, it, expect } from 'vitest';
import { SituationInterpreter, DecisionMaker } from '@skytwin/decision-engine';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { ExplanationGenerator } from '@skytwin/explanations';
import {
  ConfidenceLevel,
  SituationType,
  TrustTier,
} from '@skytwin/shared-types';
import type {
  TwinProfile, Preference, Inference, TwinEvidence, FeedbackEvent,
  DecisionObject, DecisionOutcome, CandidateAction, RiskAssessment,
  ExplanationRecord, ActionPolicy, BehavioralPattern, CrossDomainTrait,
} from '@skytwin/shared-types';
import type { TwinRepositoryPort, PatternRepositoryPort } from '@skytwin/twin-model';
import type { DecisionRepositoryPort } from '@skytwin/decision-engine';
import type { ExplanationRepositoryPort } from '@skytwin/explanations';
import type { PolicyRepositoryPort } from '@skytwin/policy-engine';

function createInMemoryTwinRepo(): TwinRepositoryPort {
  const profiles = new Map<string, TwinProfile>(); const preferences = new Map<string, Preference[]>();
  const inferences = new Map<string, Inference[]>(); const evidence = new Map<string, TwinEvidence[]>();
  const feedback = new Map<string, FeedbackEvent[]>();
  return {
    async getProfile(u: string) { return profiles.get(u) ?? null; },
    async createProfile(p: TwinProfile) { profiles.set(p.userId, p); return p; },
    async updateProfile(p: TwinProfile) { profiles.set(p.userId, p); return p; },
    async getPreferences(u: string) { return preferences.get(u) ?? []; },
    async getPreferencesByDomain(u: string, d: string) { return (preferences.get(u) ?? []).filter(p => p.domain === d); },
    async upsertPreference(u: string, pref: Preference) {
      const e = preferences.get(u) ?? []; const i = e.findIndex(p => p.domain === pref.domain && p.key === pref.key);
      if (i >= 0) e[i] = pref; else e.push(pref); preferences.set(u, e); return pref;
    },
    async getInferences(u: string) { return inferences.get(u) ?? []; },
    async upsertInference(u: string, inf: Inference) {
      const e = inferences.get(u) ?? []; const i = e.findIndex(x => x.domain === inf.domain && x.key === inf.key);
      if (i >= 0) e[i] = inf; else e.push(inf); inferences.set(u, e); return inf;
    },
    async addEvidence(ev: TwinEvidence) { const e = evidence.get(ev.userId) ?? []; e.push(ev); evidence.set(ev.userId, e); return ev; },
    async getEvidence(u: string, l?: number) { const a = evidence.get(u) ?? []; return l ? a.slice(0, l) : a; },
    async getEvidenceByIds(ids: string[]) { const a: TwinEvidence[] = []; for (const e of evidence.values()) a.push(...e.filter(v => ids.includes(v.id))); return a; },
    async addFeedback(fb: FeedbackEvent) { const e = feedback.get(fb.userId) ?? []; e.push(fb); feedback.set(fb.userId, e); return fb; },
    async getFeedback(u: string, l?: number) { const a = feedback.get(u) ?? []; return l ? a.slice(0, l) : a; },
  };
}

function createInMemoryPatternRepo(): PatternRepositoryPort {
  const p = new Map<string, BehavioralPattern[]>(); const t = new Map<string, CrossDomainTrait[]>();
  return {
    async getPatterns(u: string) { return p.get(u) ?? []; },
    async upsertPattern(u: string, pat: BehavioralPattern) { const e = p.get(u) ?? []; e.push(pat); p.set(u, e); return pat; },
    async getTraits(u: string) { return t.get(u) ?? []; },
    async upsertTrait(u: string, tr: CrossDomainTrait) { const e = t.get(u) ?? []; e.push(tr); t.set(u, e); return tr; },
  };
}

function createInMemoryDecisionRepo(): DecisionRepositoryPort {
  const d = new Map<string, DecisionObject>(); const o = new Map<string, DecisionOutcome>();
  const c = new Map<string, CandidateAction[]>(); const r = new Map<string, RiskAssessment>();
  return {
    async saveDecision(dec: DecisionObject) { d.set(dec.id, dec); return dec; },
    async getDecision(id: string) { return d.get(id) ?? null; },
    async saveOutcome(out: DecisionOutcome) { o.set(out.decisionId, out); return out; },
    async getOutcome(id: string) { return o.get(id) ?? null; },
    async saveCandidates(cands: CandidateAction[]) { if (cands.length) c.set(cands[0]!.decisionId, cands); return cands; },
    async getCandidates(id: string) { return c.get(id) ?? []; },
    async saveRiskAssessment(a: RiskAssessment) { r.set(a.actionId, a); return a; },
    async getRiskAssessment(id: string) { return r.get(id) ?? null; },
    async getRecentDecisions() { return Array.from(d.values()); },
  };
}

function createInMemoryExplanationRepo(): ExplanationRepositoryPort & { records: ExplanationRecord[] } {
  const records: ExplanationRecord[] = [];
  return {
    records,
    async save(r: ExplanationRecord) { records.push(r); return r; },
    async getByDecisionId(id: string) { return records.find(r => r.decisionId === id) ?? null; },
    async getByUserId(u: string, l?: number) { const m = records.filter(r => r.userId === u); return l ? m.slice(0, l) : m; },
  };
}

function createMockPolicyRepo(): PolicyRepositoryPort {
  const p: ActionPolicy[] = [];
  return {
    async getAllPolicies() { return p; },
    async getEnabledPolicies() { return p.filter(x => x.enabled); },
    async getPolicy(id: string) { return p.find(x => x.id === id) ?? null; },
    async getPoliciesByDomain(d: string) { return p.filter(x => x.name.includes(d)); },
    async savePolicy(pol: ActionPolicy) { p.push(pol); return pol; },
    async updatePolicy(pol: ActionPolicy) { return pol; },
    async deletePolicy() {},
  };
}

describe('Subscription Renewal E2E', () => {
  it('full pipeline: subscription renewal → interpret → decide → explain', async () => {
    const twinService = new TwinService(createInMemoryTwinRepo(), createInMemoryPatternRepo());
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const decisionMaker = new DecisionMaker(twinService, policyEvaluator, createInMemoryDecisionRepo());
    const explanationRepo = createInMemoryExplanationRepo();
    const explanationGenerator = new ExplanationGenerator(explanationRepo);
    const interpreter = new SituationInterpreter();

    const userId = 'user_subscription';
    await twinService.getOrCreateProfile(userId);
    await twinService.updatePreference(userId, {
      id: 'pref_auto_renew',
      domain: 'subscriptions',
      key: 'auto_renew_low_cost',
      value: true,
      confidence: ConfidenceLevel.CONFIRMED,
      source: 'explicit',
      evidenceIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const decision = interpreter.interpret({
      source: 'billing',
      type: 'subscription_renewal',
      userId,
      subject: 'Spotify Premium Renewal - $9.99/month',
      subscriptionName: 'Spotify Premium',
      costCents: 999,
      renewalDate: '2026-04-15',
    });

    expect(decision.situationType).toBe(SituationType.SUBSCRIPTION_RENEWAL);
    expect(decision.domain).toBe('subscriptions');

    const preferences = await twinService.getRelevantPreferences(userId, decision.domain, decision.summary);
    const context = {
      userId,
      decision,
      trustTier: TrustTier.MODERATE_AUTONOMY,
      relevantPreferences: preferences,
      timestamp: new Date(),
      patterns: [],
      traits: [],
      temporalProfile: undefined,
    };

    const outcome = await decisionMaker.evaluate(context);
    expect(outcome).toBeDefined();
    expect(outcome.riskAssessment).toBeDefined();

    const explanation = await explanationGenerator.generate(decision, outcome, context);
    expect(explanation.decisionId).toBe(decision.id);
    expect(explanationRepo.records.length).toBe(1);
  });
});
