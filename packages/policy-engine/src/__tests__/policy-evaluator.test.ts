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
