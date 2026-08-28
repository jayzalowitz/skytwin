/**
 * Regression: per-user autonomy settings must reach the policy evaluator on
 * the primary ingest path.
 *
 * `DecisionMaker.evaluate` used to call `policyEvaluator.evaluate` with four
 * arguments, dropping the fifth (`autonomySettings`). Everything the
 * evaluator gates on that argument was therefore skipped for every signal
 * that came through `POST /api/events/ingest`: the per-user pause kill
 * switch (#379), the domain allow/block lists, the per-action spend cap, the
 * `costZeroIntent === 'unknown'` escalation (#372),
 * `requireApprovalForIrreversible`, and quiet hours.
 *
 * These tests wire the REAL `PolicyEvaluator` (not a mock) behind the real
 * `DecisionMaker` so the plumbing is exercised end to end — a mocked
 * evaluator would happily accept four arguments forever.
 */
import { describe, it, expect } from 'vitest';
import {
  ConfidenceLevel,
  SituationType,
  TrustTier,
  type ActionPolicy,
  type AutonomySettings,
  type BehavioralPattern,
  type CandidateAction,
  type CrossDomainTrait,
  type DecisionContext,
  type DecisionObject,
  type DecisionOutcome,
  type FeedbackEvent,
  type Inference,
  type Preference,
  type RiskAssessment,
  type TwinEvidence,
  type TwinProfile,
} from '@skytwin/shared-types';
import { parseAutonomySettings } from '@skytwin/shared-types';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import {
  TwinService,
  type PatternRepositoryPort,
  type TwinRepositoryPort,
} from '@skytwin/twin-model';
import { DecisionMaker } from '../decision-maker.js';

// ── Minimal in-memory repos ────────────────────────────────────────────────

class TwinRepo implements TwinRepositoryPort {
  private profiles = new Map<string, TwinProfile>();
  private prefs = new Map<string, Preference[]>();
  private inferences = new Map<string, Inference[]>();
  private evidence: TwinEvidence[] = [];
  private feedback: FeedbackEvent[] = [];
  async getProfile(userId: string) { return this.profiles.get(userId) ?? null; }
  async createProfile(p: TwinProfile) { this.profiles.set(p.userId, p); return p; }
  async updateProfile(p: TwinProfile) { this.profiles.set(p.userId, p); return p; }
  async getPreferences(userId: string) { return this.prefs.get(userId) ?? []; }
  async getPreferencesByDomain(userId: string, domain: string) {
    return (this.prefs.get(userId) ?? []).filter((p) => p.domain === domain);
  }
  async upsertPreference(userId: string, p: Preference) {
    const list = this.prefs.get(userId) ?? [];
    list.push(p);
    this.prefs.set(userId, list);
    return p;
  }
  async getInferences(userId: string) { return this.inferences.get(userId) ?? []; }
  async upsertInference(userId: string, i: Inference) {
    const list = this.inferences.get(userId) ?? [];
    list.push(i);
    this.inferences.set(userId, list);
    return i;
  }
  async addEvidence(e: TwinEvidence) { this.evidence.push(e); return e; }
  async getEvidence() { return this.evidence; }
  async getEvidenceByIds(ids: string[]) { return this.evidence.filter((e) => ids.includes(e.id)); }
  async addFeedback(f: FeedbackEvent) { this.feedback.push(f); return f; }
  async getFeedback() { return this.feedback; }
}

class PatternRepo implements PatternRepositoryPort {
  async getPatterns() { return [] as BehavioralPattern[]; }
  async upsertPattern(_userId: string, p: BehavioralPattern) { return p; }
  async getTraits() { return [] as CrossDomainTrait[]; }
  async upsertTrait(_userId: string, t: CrossDomainTrait) { return t; }
}

class DecisionRepo {
  outcomes = new Map<string, DecisionOutcome>();
  candidates = new Map<string, CandidateAction[]>();
  risks = new Map<string, RiskAssessment>();
  async saveOutcome(o: DecisionOutcome) { this.outcomes.set(o.decisionId, o); return o; }
  async saveCandidates(cs: CandidateAction[]) {
    if (cs.length > 0) this.candidates.set(cs[0]!.decisionId, cs);
    return cs;
  }
  async saveRiskAssessment(a: RiskAssessment) { this.risks.set(a.actionId, a); return a; }
  async getRiskAssessment(actionId: string) { return this.risks.get(actionId) ?? null; }
}

class PolicyRepo {
  policies: ActionPolicy[] = [];
  async getAllPolicies() { return this.policies; }
  async getEnabledPolicies() { return this.policies; }
  async getPolicy(id: string) { return this.policies.find((p) => p.id === id) ?? null; }
  async getPoliciesByDomain() { return this.policies; }
  async savePolicy(p: ActionPolicy) { this.policies.push(p); return p; }
  async updatePolicy(p: ActionPolicy) { return p; }
  async deletePolicy() { /* no-op */ }
}

const USER = 'autonomy-user';

const BASE_AUTONOMY: AutonomySettings = {
  maxSpendPerActionCents: 100,
  maxDailySpendCents: 1000,
  allowedDomains: [],
  blockedDomains: [],
  requireApprovalForIrreversible: true,
};

/** An inbound Gmail signal — content the user did not author. */
function inboundGmailDecision(id = 'dec-autonomy-1'): DecisionObject {
  return {
    id,
    situationType: SituationType.EMAIL_TRIAGE,
    domain: 'email',
    urgency: 'low',
    summary: 'Email triage needed for "Weekly Newsletter"',
    rawData: {
      source: 'gmail',
      emailId: 'msg-1',
      from: 'newsletter@techdigest.com',
      subject: 'Weekly Newsletter',
      importance: 'low',
      category: 'newsletter',
      text: 'This week in tech.',
    },
    interpretedAt: new Date(),
  };
}

/**
 * A HIGH-confidence `email / auto_archive` preference. `archive_email` is
 * reversible and zero-cost, and `shouldAutoExecute` needs at least MODERATE
 * confidence, so this is what makes the control case genuinely
 * auto-executable — the thing every "…but not when paused" assertion below
 * is measured against.
 */
function autoArchivePreference(): Preference {
  return {
    id: 'pref-auto-archive',
    domain: 'email',
    key: 'auto_archive',
    value: true,
    confidence: ConfidenceLevel.HIGH,
    source: 'explicit',
    evidenceIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * A candidate + a policy that denies it. Used to source a deny from the POLICY
 * LOOP specifically, rather than from autonomy settings — those are checked
 * earlier and early-return, so a settings-sourced deny never exercises the
 * quiet-hours ordering at all.
 */
function emailCandidate(): CandidateAction {
  return {
    id: 'cand-quiet-hours',
    decisionId: 'dec-quiet-hours',
    actionType: 'archive_email',
    description: 'Archive this email',
    domain: 'email',
    parameters: {},
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero',
    reversible: true,
    confidence: 'high' as CandidateAction['confidence'],
    reasoning: 'routine',
    provenance: 'user_authored',
  };
}

const DENY_ALL_POLICY: ActionPolicy = {
  id: 'test_deny_all',
  name: 'Deny All',
  description: 'Test policy that denies the candidate above.',
  rules: [
    {
      id: 'rule_deny_all',
      policyId: 'test_deny_all',
      condition: { field: 'actionType', operator: 'eq', value: 'archive_email' },
      effect: 'deny',
      reason: 'Denied by test policy.',
    },
  ],
  priority: 100,
  enabled: true,
  builtIn: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function setupHarness(policies: ActionPolicy[] = []): DecisionMaker {
  const twinRepo = new TwinRepo();
  void twinRepo.createProfile({
    id: 'twin-autonomy',
    userId: USER,
    version: 1,
    preferences: [autoArchivePreference()],
    inferences: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const policyRepo = new PolicyRepo();
  policyRepo.policies = policies;
  return new DecisionMaker(
    new TwinService(twinRepo, new PatternRepo()),
    new PolicyEvaluator(policyRepo),
    new DecisionRepo() as never,
  );
}

function contextWith(
  autonomySettings: AutonomySettings | undefined,
  trustTier: TrustTier = TrustTier.LOW_AUTONOMY,
  decision: DecisionObject = inboundGmailDecision(),
): DecisionContext {
  return {
    userId: USER,
    decision,
    trustTier,
    relevantPreferences: [],
    timestamp: new Date(),
    patterns: [],
    traits: [],
    episodicMemories: [],
    ...(autonomySettings ? { autonomySettings } : {}),
  };
}

/**
 * Build a quiet-hours window that definitely contains "now" (a two-hour
 * window centred on the current local hour), so the test can't go green or
 * red depending on when CI happens to run.
 */
function quietHoursAroundNow(): { quietHoursStart: string; quietHoursEnd: string } {
  const now = new Date();
  const pad = (n: number) => String((n + 24) % 24).padStart(2, '0');
  return {
    quietHoursStart: `${pad(now.getHours() - 1)}:00`,
    quietHoursEnd: `${pad(now.getHours() + 2)}:00`,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('autonomy settings reach the policy evaluator (primary ingest path)', () => {
  it('control: a LOW_AUTONOMY user with permissive settings still auto-executes', async () => {
    // Guards the tests below from going green for the wrong reason: if this
    // case did not auto-execute, "paused blocks auto-execute" would prove
    // nothing.
    const outcome = await setupHarness().evaluate(contextWith(BASE_AUTONOMY));

    expect(outcome.selectedAction).not.toBeNull();
    expect(outcome.autoExecute).toBe(true);
    expect(outcome.requiresApproval).toBe(false);
  });

  it('paused: LOW_AUTONOMY + paused === true + inbound gmail signal never auto-executes', async () => {
    const outcome = await setupHarness().evaluate(
      contextWith({
        ...BASE_AUTONOMY,
        paused: true,
        pausedAt: new Date().toISOString(),
        pausedReason: 'Going on holiday',
      }),
    );

    expect(outcome.autoExecute).toBe(false);
    expect(outcome.requiresApproval).toBe(true);
    // The user-facing reason must say the pause is why, not something generic.
    expect(outcome.reasoning.toLowerCase()).toContain('paused');
  });

  it('paused: the kill switch travels even when the context omits everything else optional', async () => {
    const outcome = await setupHarness().evaluate({
      userId: USER,
      decision: inboundGmailDecision(),
      trustTier: TrustTier.HIGH_AUTONOMY,
      relevantPreferences: [],
      timestamp: new Date(),
      autonomySettings: { ...BASE_AUTONOMY, paused: true },
    });

    expect(outcome.autoExecute).toBe(false);
    expect(outcome.requiresApproval).toBe(true);
  });

  it('quiet hours: an active window escalates auto-execute to approval', async () => {
    const outcome = await setupHarness().evaluate(
      contextWith({ ...BASE_AUTONOMY, ...quietHoursAroundNow() }),
    );

    expect(outcome.autoExecute).toBe(false);
    expect(outcome.requiresApproval).toBe(true);
    expect(outcome.reasoning.toLowerCase()).toContain('quiet hours');
  });

  it('domain allowlist: an email action for a calendar-only allowlist is denied', async () => {
    const outcome = await setupHarness().evaluate(
      contextWith({ ...BASE_AUTONOMY, allowedDomains: ['calendar'] }),
    );

    // Every candidate is in the `email` domain, so all of them are denied and
    // nothing is selected for execution or approval.
    expect(outcome.selectedAction).toBeNull();
    expect(outcome.autoExecute).toBe(false);
    expect(Object.values(outcome.policyVerdicts ?? {})).not.toContain('allowed');
    expect(outcome.reasoning.toLowerCase()).toContain('blocked');
  });

  it('domain blocklist: a blocked domain is denied, not escalated', async () => {
    const outcome = await setupHarness().evaluate(
      contextWith({ ...BASE_AUTONOMY, blockedDomains: ['email'] }),
    );

    expect(outcome.selectedAction).toBeNull();
    expect(outcome.autoExecute).toBe(false);
  });

  it('quiet hours do NOT flip a POLICY deny into an approval (codex review [P1])', async () => {
    // Evaluator-level on purpose. The deny has to come from the POLICY LOOP:
    // `checkAutonomySettings` (blockedDomains / allowlist / spend) runs and
    // early-returns BEFORE quiet hours, so a settings-sourced deny never
    // exercises this ordering — a test written that way passes even with the
    // bug present (verified: it did).
    //
    // Quiet hours used to early-return `allowed: true, requiresApproval: true`
    // ahead of that loop, so an active window converted a deny into a mere
    // approval prompt. Escalation is weaker than denial; denial must win.
    const evaluator = new PolicyEvaluator(new PolicyRepo());
    const decision = await evaluator.evaluate(
      emailCandidate(),
      [DENY_ALL_POLICY],
      TrustTier.HIGH_AUTONOMY,
      undefined,
      { ...BASE_AUTONOMY, ...quietHoursAroundNow() },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.blockingPolicy?.id).toBe(DENY_ALL_POLICY.id);
  });

  it('quiet hours + pause together still lose to a policy deny', async () => {
    const evaluator = new PolicyEvaluator(new PolicyRepo());
    const decision = await evaluator.evaluate(
      emailCandidate(),
      [DENY_ALL_POLICY],
      TrustTier.HIGH_AUTONOMY,
      undefined,
      { ...BASE_AUTONOMY, ...quietHoursAroundNow(), paused: true },
    );

    expect(decision.allowed).toBe(false);
  });

  it('a malformed allowlist denies rather than becoming unrestricted (codex review [P1])', async () => {
    // Raw JSONB the parser has to narrow. Filtering the junk out would leave
    // an EMPTY allowlist, which PolicyEvaluator reads as "allow every domain"
    // — turning a deny-everything config into an allow-everything one.
    const parsed = parseAutonomySettings({ ...BASE_AUTONOMY, allowedDomains: [42, null] });
    const outcome = await setupHarness().evaluate(contextWith(parsed));

    expect(outcome.selectedAction).toBeNull();
    expect(outcome.autoExecute).toBe(false);
  });

  it('kill switch does NOT flip a deny into an approval (regression from PR #421)', async () => {
    // Both a deny source (domain blocked) and the pause are active. The pause
    // is captured up front but applied LAST, so it may only escalate actions
    // that would otherwise have been allowed. If it early-returned ahead of
    // the deny checks, every denied candidate would come back as
    // `allowed: true, requiresApproval: true` — the exact regression Copilot
    // caught on PR #421.
    const paused: AutonomySettings = {
      ...BASE_AUTONOMY,
      blockedDomains: ['email'],
      paused: true,
    };
    const outcome = await setupHarness().evaluate(contextWith(paused));

    expect(outcome.selectedAction).toBeNull();
    expect(outcome.autoExecute).toBe(false);
    const verdicts = Object.values(outcome.policyVerdicts ?? {});
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((v) => v === 'denied')).toBe(true);
    expect(verdicts).not.toContain('requires-approval');
  });

  it('kill switch does NOT strip the injection guard confirmation level', async () => {
    // A destructive-shaped action from untrusted content demands
    // confirmation. Pausing must not downgrade that verdict — it escalates,
    // it never relaxes.
    const evaluator = new PolicyEvaluator(new PolicyRepo());
    const destructive: CandidateAction = {
      id: 'cand-destructive',
      decisionId: 'dec-destructive',
      actionType: 'delete_account',
      description: 'Delete the account',
      domain: 'general',
      parameters: {},
      estimatedCostCents: 0,
      costZeroIntent: 'verified_zero',
      reversible: false,
      confidence: 'high' as CandidateAction['confidence'],
      reasoning: 'inbound email asked for it',
      provenance: 'untrusted_external',
    };

    const decision = await evaluator.evaluate(
      destructive,
      [],
      TrustTier.HIGH_AUTONOMY,
      undefined,
      { ...BASE_AUTONOMY, paused: true },
    );

    expect(decision.requiresApproval).toBe(true);
    expect(decision.confirmationLevel).toBe('dual');
  });

  it('regression guard: omitting autonomySettings is what the bug looked like', async () => {
    // Documents the pre-fix behaviour so the diff is legible: with no
    // autonomy settings on the context, none of the above gates can fire and
    // the same signal auto-executes. This is why `DecisionContext` carries
    // the field and `apps/api/src/routes/events.ts` populates it.
    const outcome = await setupHarness().evaluate(contextWith(undefined));

    expect(outcome.autoExecute).toBe(true);
  });
});
