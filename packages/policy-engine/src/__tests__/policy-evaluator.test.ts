import { describe, it, expect, vi } from 'vitest';
import { PolicyEvaluator } from '../policy-evaluator.js';
import type {
  CandidateAction,
  RiskAssessment,
  AutonomySettings,
} from '@skytwin/shared-types';
import {
  ConfidenceLevel,
  RiskTier,
  RiskDimension,
  TrustTier,
} from '@skytwin/shared-types';

// ── Mock PolicyRepository ──────────────────────────────────────────

function createMockPolicyRepository() {
  return {
    getEnabledPolicies: vi.fn().mockResolvedValue([]),
    getPoliciesForUser: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    createPolicy: vi.fn(),
    updatePolicy: vi.fn(),
    deletePolicy: vi.fn(),
    hardDeletePolicy: vi.fn(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function createAction(overrides?: Partial<CandidateAction>): CandidateAction {
  return {
    id: 'action_test',
    decisionId: 'dec_test',
    actionType: 'archive_email',
    description: 'Archive this email',
    domain: 'email',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.MODERATE,
    reasoning: 'Test action',
    ...overrides,
  };
}

function createRiskAssessment(
  overallTier: RiskTier = RiskTier.NEGLIGIBLE,
): RiskAssessment {
  const defaultDim = { tier: RiskTier.NEGLIGIBLE, score: 0, reasoning: 'OK' };

  return {
    actionId: 'action_test',
    overallTier,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: defaultDim,
      [RiskDimension.FINANCIAL_IMPACT]: defaultDim,
      [RiskDimension.LEGAL_SENSITIVITY]: defaultDim,
      [RiskDimension.PRIVACY_SENSITIVITY]: defaultDim,
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: defaultDim,
      [RiskDimension.OPERATIONAL_RISK]: defaultDim,
    },
    reasoning: 'Overall risk is negligible.',
    assessedAt: new Date(),
  };
}

function createAutonomySettings(
  overrides?: Partial<AutonomySettings>,
): AutonomySettings {
  return {
    maxSpendPerActionCents: 5000,
    maxDailySpendCents: 50000,
    allowedDomains: [],
    blockedDomains: [],
    requireApprovalForIrreversible: true,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('PolicyEvaluator', () => {
  describe('Kill switch (#379)', () => {
    it('escalates every action when globallyPaused (operator env var)', async () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never, { globallyPaused: true });
      const action = createAction();
      const riskAssessment = createRiskAssessment(RiskTier.NEGLIGIBLE);
      const settings = createAutonomySettings();

      const decision = await evaluator.evaluate(
        action,
        [],
        TrustTier.HIGH_AUTONOMY, // even max trust escalates when operator paused
        riskAssessment,
        settings,
      );

      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(true);
      expect(decision.reason).toMatch(/operator/i);
      expect(decision.reason).toMatch(/SKYTWIN_AUTO_EXECUTE_DISABLED/);
    });

    it('escalates every action when per-user paused (autonomySettings.paused)', async () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction();
      const riskAssessment = createRiskAssessment(RiskTier.NEGLIGIBLE);
      const settings = createAutonomySettings({ paused: true });

      const decision = await evaluator.evaluate(
        action,
        [],
        TrustTier.HIGH_AUTONOMY,
        riskAssessment,
        settings,
      );

      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(true);
      expect(decision.reason).toMatch(/paused by user/i);
    });

    it('operator pause reason wins when both flags are set', async () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never, { globallyPaused: true });
      const action = createAction();
      const settings = createAutonomySettings({ paused: true });

      const decision = await evaluator.evaluate(
        action,
        [],
        TrustTier.HIGH_AUTONOMY,
        createRiskAssessment(RiskTier.NEGLIGIBLE),
        settings,
      );

      expect(decision.requiresApproval).toBe(true);
      // Operator wins: reason should reference the env var, not the user toggle.
      expect(decision.reason).toMatch(/operator/i);
      expect(decision.reason).not.toMatch(/paused by user/i);
    });

    it('does NOT escalate when neither pause flag is set (regression check)', async () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never, { globallyPaused: false });
      const action = createAction();
      const settings = createAutonomySettings({ paused: false });

      const decision = await evaluator.evaluate(
        action,
        [],
        TrustTier.HIGH_AUTONOMY,
        createRiskAssessment(RiskTier.NEGLIGIBLE),
        settings,
      );

      // High trust + no policies + low risk → should auto-execute.
      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(false);
    });

    it('isGloballyPaused reports the construction-time state', () => {
      const repo = createMockPolicyRepository();
      expect(new PolicyEvaluator(repo as never, { globallyPaused: true }).isGloballyPaused()).toBe(true);
      expect(new PolicyEvaluator(repo as never, { globallyPaused: false }).isGloballyPaused()).toBe(false);
    });

    it('kill switch does NOT override a deny — domain blocklist still wins (#379, post-Copilot)', async () => {
      // Pre-Copilot the early-return at the top of evaluate() turned
      // every action — including ones that would have been DENIED for
      // domain-blocked, spend-cap-exceeded, etc. — into approved-with-
      // confirmation. Denies are strictly stricter than approvals;
      // never relax them. The kill switch now only escalates would-
      // have-been-allowed actions; denies short-circuit first.
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never, { globallyPaused: true });
      const action = createAction({ domain: 'gambling' });
      const settings = createAutonomySettings({ blockedDomains: ['gambling'] });

      const decision = await evaluator.evaluate(
        action,
        [],
        TrustTier.MODERATE_AUTONOMY,
        createRiskAssessment(RiskTier.LOW),
        settings,
      );

      expect(decision.allowed).toBe(false);
      expect(decision.requiresApproval).toBe(false);
      expect(decision.reason).toMatch(/domain/i);
    });
  });

  describe('Spend limit enforcement', () => {
    it('should allow actions within spend limit', () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({ estimatedCostCents: 3000 });
      const settings = createAutonomySettings({ maxSpendPerActionCents: 5000 });

      const result = evaluator.checkSpendLimit(action, settings);
      expect(result).toBe(true);
    });

    it('should block actions exceeding spend limit', () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({ estimatedCostCents: 10000 });
      const settings = createAutonomySettings({ maxSpendPerActionCents: 5000 });

      const result = evaluator.checkSpendLimit(action, settings);
      expect(result).toBe(false);
    });

    it('should allow zero-cost actions regardless of limit', () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({ estimatedCostCents: 0 });
      const settings = createAutonomySettings({ maxSpendPerActionCents: 0 });

      const result = evaluator.checkSpendLimit(action, settings);
      expect(result).toBe(true);
    });

    it('should REJECT zero-cost actions tagged costZeroIntent="unknown" (#372)', () => {
      // LLM-generated candidates emit estimatedCostCents=0 with
      // costZeroIntent='unknown' because the LLM does not get to
      // declare its own price. Pre-#372 the zero-cost fast-path
      // auto-approved every LLM candidate; the cap was silently
      // bypassed. Now the policy engine refuses the fast-path so
      // the candidate escalates.
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({
        estimatedCostCents: 0,
        costZeroIntent: 'unknown',
      });
      const settings = createAutonomySettings({ maxSpendPerActionCents: 5000 });

      const result = evaluator.checkSpendLimit(action, settings);
      expect(result).toBe(false);
    });

    it('should fast-path zero-cost actions tagged costZeroIntent="verified_zero"', () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({
        estimatedCostCents: 0,
        costZeroIntent: 'verified_zero',
      });
      const settings = createAutonomySettings({ maxSpendPerActionCents: 0 });

      const result = evaluator.checkSpendLimit(action, settings);
      expect(result).toBe(true);
    });

    it('should fast-path zero-cost actions with undefined costZeroIntent (legacy compat)', () => {
      // Pre-#372 rule-based generators (decision-maker.ts, sender-aware,
      // draft-email) emit naked `estimatedCostCents: 0` with no intent
      // tag. They are genuinely free; backward compatibility means
      // undefined intent fast-paths cleanly.
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({ estimatedCostCents: 0 });
      delete (action as { costZeroIntent?: unknown }).costZeroIntent;
      const settings = createAutonomySettings({ maxSpendPerActionCents: 0 });

      const result = evaluator.checkSpendLimit(action, settings);
      expect(result).toBe(true);
    });

    it('evaluate() ESCALATES (not denies) a costZeroIntent="unknown" candidate (#372)', async () => {
      // Pre-Copilot-fix the policy engine treated a failed spend check
      // as a hard deny. The Copilot review on PR #418 flagged that
      // semantically an LLM candidate with cost-unknown should be
      // escalated to human approval — denial silently drops the
      // candidate and the user never sees it. Evaluate() now special-
      // cases costZeroIntent='unknown' to allowed+requiresApproval
      // BEFORE the spend-limit check runs.
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({
        estimatedCostCents: 0,
        costZeroIntent: 'unknown',
      });
      const settings = createAutonomySettings({ maxSpendPerActionCents: 5000 });
      const riskAssessment = createRiskAssessment(RiskTier.LOW);

      const decision = await evaluator.evaluate(
        action,
        [],
        TrustTier.MODERATE_AUTONOMY,
        riskAssessment,
        settings,
      );

      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(true);
      expect(decision.reason).toMatch(/no verified cost estimate/i);
    });
  });

  describe('Irreversibility checks', () => {
    it('should allow reversible actions regardless of risk', () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({ reversible: true });
      const riskAssessment = createRiskAssessment(RiskTier.HIGH);

      const result = evaluator.checkReversibility(action, riskAssessment);
      expect(result).toBe(true);
    });

    it('should allow irreversible actions with low risk', () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({ reversible: false });
      const riskAssessment = createRiskAssessment(RiskTier.LOW);

      const result = evaluator.checkReversibility(action, riskAssessment);
      expect(result).toBe(true);
    });

    it('should block irreversible actions with moderate or higher risk', () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({ reversible: false });
      const riskAssessment = createRiskAssessment(RiskTier.MODERATE);

      const result = evaluator.checkReversibility(action, riskAssessment);
      expect(result).toBe(false);
    });
  });

  describe('Domain allowlist/blocklist', () => {
    it('should allow any domain when no lists are configured', () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const settings = createAutonomySettings({
        allowedDomains: [],
        blockedDomains: [],
      });

      expect(evaluator.checkDomainAllowlist('email', settings)).toBe(true);
      expect(evaluator.checkDomainAllowlist('calendar', settings)).toBe(true);
      expect(evaluator.checkDomainAllowlist('any_domain', settings)).toBe(true);
    });

    it('should block domains in the blocklist', () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const settings = createAutonomySettings({
        blockedDomains: ['social_media', 'gambling'],
      });

      expect(evaluator.checkDomainAllowlist('social_media', settings)).toBe(false);
      expect(evaluator.checkDomainAllowlist('gambling', settings)).toBe(false);
      expect(evaluator.checkDomainAllowlist('email', settings)).toBe(true);
    });

    it('should only allow domains in the allowlist when configured', () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const settings = createAutonomySettings({
        allowedDomains: ['email', 'calendar'],
      });

      expect(evaluator.checkDomainAllowlist('email', settings)).toBe(true);
      expect(evaluator.checkDomainAllowlist('calendar', settings)).toBe(true);
      expect(evaluator.checkDomainAllowlist('shopping', settings)).toBe(false);
    });
  });

  describe('Trust tier gating', () => {
    it('should require approval for all actions on observer trust tier', async () => {
      // Observer is allow-with-approval, not deny: the twin never auto-executes
      // at this tier, but actions must surface as approval requests so the
      // observer→suggest promotion path (10 approvals) is reachable.
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction();
      const riskAssessment = createRiskAssessment(RiskTier.NEGLIGIBLE);

      const result = await evaluator.evaluate(
        action,
        [],
        TrustTier.OBSERVER,
        riskAssessment,
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.reason).toContain('Observer');
      // A benign reversible action draws no injection-guard escalation, so
      // the approval requirement here is the tier's alone — proving observer
      // gates on its own, not by riding a guard escalation.
      expect(result.confirmationLevel).toBeUndefined();
    });

    it('regression: observer is never denied at any risk tier — the promotion trap', async () => {
      // Regression guard for the observer→suggest promotion trap. Observer
      // gating previously returned `allowed: false` (and the TRUST_TIER_GATING
      // default policy carried `effect: 'deny'`). A deny produces no approval
      // request; the observer→suggest promotion needs 10 *approvals*; so a
      // new user could never leave observer — a permanent chicken-and-egg
      // trap. Both layers must keep observer at allow-with-approval. If a
      // future edit reverts either one, this fails loudly.
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);

      for (const tier of [
        RiskTier.NEGLIGIBLE,
        RiskTier.LOW,
        RiskTier.MODERATE,
        RiskTier.HIGH,
        RiskTier.CRITICAL,
      ]) {
        const result = await evaluator.evaluate(
          createAction(),
          [],
          TrustTier.OBSERVER,
          createRiskAssessment(tier),
        );

        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(true);
      }
    });

    it('keeps observer allow-with-approval through the quiet-hours early return', async () => {
      // Observer now flows past the tier check into the autonomy-settings and
      // quiet-hours paths — it used to hard-deny before reaching them. The
      // quiet-hours early return must preserve the tier's approval
      // requirement; pin the clock inside a quiet window to exercise it.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T03:00:00'));
      try {
        const repo = createMockPolicyRepository();
        const evaluator = new PolicyEvaluator(repo as never);

        const result = await evaluator.evaluate(
          createAction(),
          [],
          TrustTier.OBSERVER,
          createRiskAssessment(RiskTier.NEGLIGIBLE),
          createAutonomySettings({ quietHoursStart: '22:00', quietHoursEnd: '07:00' }),
        );

        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should require approval for suggest trust tier', async () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction();
      const riskAssessment = createRiskAssessment(RiskTier.NEGLIGIBLE);

      const result = await evaluator.evaluate(
        action,
        [],
        TrustTier.SUGGEST,
        riskAssessment,
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('should allow low-risk actions for low_autonomy trust tier', async () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({
        estimatedCostCents: 0,
        reversible: true,
      });
      const riskAssessment = createRiskAssessment(RiskTier.NEGLIGIBLE);

      const result = await evaluator.evaluate(
        action,
        [],
        TrustTier.LOW_AUTONOMY,
        riskAssessment,
      );

      expect(result.allowed).toBe(true);
    });

    it('should require approval for high-risk actions on moderate_autonomy', async () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);
      const action = createAction({
        estimatedCostCents: 0,
        reversible: true,
        actionType: 'send_message',
        description: 'Send an important message to a partner',
      });
      const riskAssessment = createRiskAssessment(RiskTier.HIGH);

      const result = await evaluator.evaluate(
        action,
        [],
        TrustTier.MODERATE_AUTONOMY,
        riskAssessment,
      );

      expect(result.requiresApproval).toBe(true);
    });
  });

  describe('Full policy evaluation', () => {
    it('should allow a safe action with high trust', async () => {
      const repo = createMockPolicyRepository();
      const evaluator = new PolicyEvaluator(repo as never);

      const action = createAction({
        estimatedCostCents: 0,
        reversible: true,
      });
      const riskAssessment = createRiskAssessment(RiskTier.NEGLIGIBLE);

      const result = await evaluator.evaluate(
        action,
        [],
        TrustTier.HIGH_AUTONOMY,
        riskAssessment,
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });
  });
});
