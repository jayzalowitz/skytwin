import { describe, it, expect, vi } from 'vitest';
import { PolicyEvaluator } from '../policy-evaluator.js';
import type { CandidateAction, RiskAssessment } from '@skytwin/shared-types';
import { ConfidenceLevel, RiskTier, RiskDimension, TrustTier } from '@skytwin/shared-types';

function createMockPolicyRepository() {
  return {
    getAllPolicies: vi.fn().mockResolvedValue([]),
    getEnabledPolicies: vi.fn().mockResolvedValue([]),
    getPolicy: vi.fn().mockResolvedValue(null),
    getPoliciesByDomain: vi.fn().mockResolvedValue([]),
    savePolicy: vi.fn(),
    updatePolicy: vi.fn(),
    deletePolicy: vi.fn(),
  };
}

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
    provenance: 'user_originated',
    ...overrides,
  };
}

function lowRisk(): RiskAssessment {
  const dim = { tier: RiskTier.LOW, score: 0.1, reasoning: 'low' };
  return {
    actionId: 'action_test',
    overallTier: RiskTier.LOW,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: dim,
      [RiskDimension.FINANCIAL_IMPACT]: dim,
      [RiskDimension.LEGAL_SENSITIVITY]: dim,
      [RiskDimension.PRIVACY_SENSITIVITY]: dim,
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: dim,
      [RiskDimension.OPERATIONAL_RISK]: dim,
    },
    reasoning: 'low risk',
    assessedAt: new Date(),
  };
}

describe('PolicyEvaluator.checkInjectionGuard — unit', () => {
  const evaluator = new PolicyEvaluator(createMockPolicyRepository());

  it('does not escalate a reversible none-severity user-originated action', () => {
    const r = evaluator.checkInjectionGuard(
      createAction({ provenance: 'user_originated' }),
    );
    expect(r.requiresApproval).toBe(false);
  });

  it('does not escalate a reversible none-severity untrusted action (carve-out)', () => {
    const r = evaluator.checkInjectionGuard(
      createAction({ provenance: 'untrusted_external' }),
    );
    expect(r.requiresApproval).toBe(false);
  });

  it('escalates an untrusted irreversible action to single confirmation', () => {
    const r = evaluator.checkInjectionGuard(
      createAction({ provenance: 'untrusted_external', reversible: false, actionType: 'send_reply' }),
    );
    expect(r.requiresApproval).toBe(true);
    expect(r.confirmationLevel).toBe('single');
  });

  it('escalates a destructive action to single confirmation regardless of provenance', () => {
    const r = evaluator.checkInjectionGuard(
      createAction({ actionType: 'delete_email', provenance: 'user_originated' }),
    );
    expect(r.requiresApproval).toBe(true);
    expect(r.confirmationLevel).toBe('single');
  });

  it('escalates an extreme action to dual confirmation regardless of provenance', () => {
    const r = evaluator.checkInjectionGuard(
      createAction({ actionType: 'shell_exec', provenance: 'user_originated' }),
    );
    expect(r.requiresApproval).toBe(true);
    expect(r.confirmationLevel).toBe('dual');
  });

  it('fails safe — missing provenance + irreversible escalates', () => {
    const r = evaluator.checkInjectionGuard(
      createAction({ provenance: undefined, reversible: false, actionType: 'send_reply' }),
    );
    expect(r.requiresApproval).toBe(true);
  });
});

describe('PolicyEvaluator.evaluate — injection guard integration', () => {
  const evaluator = new PolicyEvaluator(createMockPolicyRepository());

  it('lets a reversible none-severity user-originated action auto-execute', async () => {
    const decision = await evaluator.evaluate(
      createAction({ provenance: 'user_originated' }),
      [],
      TrustTier.HIGH_AUTONOMY,
      lowRisk(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.confirmationLevel).toBeUndefined();
  });

  it('lets a reversible none-severity untrusted action auto-execute (the carve-out)', async () => {
    const decision = await evaluator.evaluate(
      createAction({ provenance: 'untrusted_external' }),
      [],
      TrustTier.HIGH_AUTONOMY,
      lowRisk(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it('forces a destructive action to approval even at HIGH_AUTONOMY', async () => {
    const decision = await evaluator.evaluate(
      createAction({ actionType: 'delete_email', provenance: 'user_originated' }),
      [],
      TrustTier.HIGH_AUTONOMY,
      lowRisk(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.confirmationLevel).toBe('single');
  });

  it('forces an extreme action to dual confirmation even at HIGH_AUTONOMY', async () => {
    const decision = await evaluator.evaluate(
      createAction({ actionType: 'drop_table', provenance: 'user_originated', reversible: false }),
      [],
      TrustTier.HIGH_AUTONOMY,
      lowRisk(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.confirmationLevel).toBe('dual');
  });

  it('forces an untrusted irreversible action to approval even at HIGH_AUTONOMY', async () => {
    const decision = await evaluator.evaluate(
      createAction({
        actionType: 'send_reply',
        provenance: 'untrusted_external',
        reversible: false,
      }),
      [],
      TrustTier.HIGH_AUTONOMY,
      lowRisk(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.confirmationLevel).toBe('single');
  });

  it('keeps the observer hard-deny — guard never downgrades a deny', async () => {
    const decision = await evaluator.evaluate(
      createAction({ actionType: 'delete_email' }),
      [],
      TrustTier.OBSERVER,
      lowRisk(),
    );
    expect(decision.allowed).toBe(false);
  });

  it('threads confirmationLevel through even when the trust tier also escalates', async () => {
    // SUGGEST tier escalates everything to approval; an extreme action must
    // still come out as dual, not plain single.
    const decision = await evaluator.evaluate(
      createAction({ actionType: 'shell_exec', provenance: 'user_originated', reversible: false }),
      [],
      TrustTier.SUGGEST,
      lowRisk(),
    );
    expect(decision.requiresApproval).toBe(true);
    expect(decision.confirmationLevel).toBe('dual');
  });

  it('does not set confirmationLevel on an action that needs no escalation', async () => {
    const decision = await evaluator.evaluate(
      createAction({ provenance: 'user_originated' }),
      [],
      TrustTier.HIGH_AUTONOMY,
      lowRisk(),
    );
    expect(decision.confirmationLevel).toBeUndefined();
  });
});
