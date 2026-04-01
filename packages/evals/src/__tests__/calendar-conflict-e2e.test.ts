/**
 * Calendar Conflict E2E Integration Test
 *
 * Validates the full pipeline for calendar conflict situations.
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

// ── Shared in-memory repo factories ──────────────────────────────

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
      if (idx >= 0) existing[idx] = pref; else existing.push(pref);
      preferences.set(userId, existing);
      return pref;
    },
    async getInferences(userId: string) { return inferences.get(userId) ?? []; },
    async upsertInference(userId: string, inf: Inference) {
      const existing = inferences.get(userId) ?? [];
      const idx = existing.findIndex(i => i.domain === inf.domain && i.key === inf.key);
      if (idx >= 0) existing[idx] = inf; else existing.push(inf);
      inferences.set(userId, existing);
      return inf;
    },
    async addEvidence(ev: TwinEvidence) { const e = evidence.get(ev.userId) ?? []; e.push(ev); evidence.set(ev.userId, e); return ev; },
    async getEvidence(userId: string, limit?: number) { const a = evidence.get(userId) ?? []; return limit ? a.slice(0, limit) : a; },
    async getEvidenceByIds(ids: string[]) { const a: TwinEvidence[] = []; for (const e of evidence.values()) a.push(...e.filter(v => ids.includes(v.id))); return a; },
    async addFeedback(fb: FeedbackEvent) { const e = feedback.get(fb.userId) ?? []; e.push(fb); feedback.set(fb.userId, e); return fb; },
    async getFeedback(userId: string, limit?: number) { const a = feedback.get(userId) ?? []; return limit ? a.slice(0, limit) : a; },
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
    async getByUserId(u: string, limit?: number) { const m = records.filter(r => r.userId === u); return limit ? m.slice(0, limit) : m; },
  };
}

function createMockPolicyRepo(): PolicyRepositoryPort {
  const p: ActionPolicy[] = [];
  return {
    async getAllPolicies() { return p; },
    async getEnabledPolicies() { return p.filter(x => x.enabled); },
    async getPolicy(id: string) { return p.find(x => x.id === id) ?? null; },
    async getPoliciesByDomain(d: string) { return p.filter(x => x.name.includes(d)); },
    async savePolicy(policy: ActionPolicy) { p.push(policy); return policy; },
    async updatePolicy(policy: ActionPolicy) { return policy; },
    async deletePolicy() { /* no-op */ },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('Calendar Conflict E2E', () => {
  it('full pipeline: calendar conflict → interpret → decide → explain', async () => {
    const twinService = new TwinService(createInMemoryTwinRepo(), createInMemoryPatternRepo());
    const policyEvaluator = new PolicyEvaluator(createMockPolicyRepo());
    const decisionMaker = new DecisionMaker(twinService, policyEvaluator, createInMemoryDecisionRepo());
    const explanationRepo = createInMemoryExplanationRepo();
    const explanationGenerator = new ExplanationGenerator(explanationRepo);
    const interpreter = new SituationInterpreter();

    const userId = 'user_calendar';
    await twinService.getOrCreateProfile(userId);
    await twinService.updatePreference(userId, {
      id: 'pref_meeting_priority',
      domain: 'calendar',
      key: 'meeting_priority',
      value: 'manager_meetings_first',
      confidence: ConfidenceLevel.HIGH,
      source: 'explicit',
      evidenceIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const decision = interpreter.interpret({
      source: 'calendar',
      type: 'calendar_conflict',
      userId,
      title: 'Team standup vs 1:1 with manager',
      conflictingEvents: ['team_standup', 'manager_1on1'],
      timeSlot: '2026-04-02T10:00:00Z',
    });

    expect(decision.situationType).toBe(SituationType.CALENDAR_CONFLICT);
    expect(decision.domain).toBe('calendar');

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
