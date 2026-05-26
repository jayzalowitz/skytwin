/**
 * Helper for the per-candidate RiskAssessment lookup (#412).
 *
 * The decision-maker now carries every candidate's assessment on the
 * outcome via the new `allRiskAssessments` field. This helper makes
 * the by-id lookup explicit so no consumer accidentally reaches for
 * `outcome.riskAssessment` (which only matches the SELECTED candidate)
 * and gets a stale assessment after a manual re-selection.
 */

import { describe, it, expect } from 'vitest';
import { getAssessmentForAction } from '../decision-helpers.js';
import type { DecisionOutcome, RiskAssessment } from '@skytwin/shared-types';
import { RiskTier, RiskDimension } from '@skytwin/shared-types';

function mkAssessment(actionId: string, tier: RiskTier = RiskTier.LOW): RiskAssessment {
  const dim = { tier, score: 0.5, reasoning: 'test' };
  return {
    actionId,
    overallTier: tier,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: dim,
      [RiskDimension.FINANCIAL_IMPACT]: dim,
      [RiskDimension.LEGAL_SENSITIVITY]: dim,
      [RiskDimension.PRIVACY_SENSITIVITY]: dim,
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: dim,
      [RiskDimension.OPERATIONAL_RISK]: dim,
    },
    reasoning: 'test',
    assessedAt: new Date(),
  };
}

function mkOutcome(overrides: Partial<DecisionOutcome>): DecisionOutcome {
  return {
    id: 'outcome-1',
    decisionId: 'dec-1',
    selectedAction: null,
    allCandidates: [],
    riskAssessment: null,
    autoExecute: false,
    requiresApproval: true,
    reasoning: 'test',
    decidedAt: new Date(),
    ...overrides,
  };
}

describe('getAssessmentForAction (#412)', () => {
  it('returns the assessment matching the requested actionId from allRiskAssessments', () => {
    const a1 = mkAssessment('action-1', RiskTier.LOW);
    const a2 = mkAssessment('action-2', RiskTier.HIGH);
    const outcome = mkOutcome({ allRiskAssessments: [a1, a2] });

    expect(getAssessmentForAction(outcome, 'action-1')).toBe(a1);
    expect(getAssessmentForAction(outcome, 'action-2')).toBe(a2);
    expect(getAssessmentForAction(outcome, 'action-1')?.overallTier).toBe(RiskTier.LOW);
    expect(getAssessmentForAction(outcome, 'action-2')?.overallTier).toBe(RiskTier.HIGH);
  });

  it('returns null when the requested id is not in allRiskAssessments', () => {
    const outcome = mkOutcome({
      allRiskAssessments: [mkAssessment('action-1')],
    });
    expect(getAssessmentForAction(outcome, 'action-unknown')).toBeNull();
  });

  it('falls back to outcome.riskAssessment when allRiskAssessments is missing AND the id matches the selected action', () => {
    // Legacy / pre-#412 outcomes (synthetic, proactive-evaluator,
    // older test fixtures). The helper degrades gracefully.
    const selected = mkAssessment('action-1');
    const outcome = mkOutcome({ riskAssessment: selected });
    delete (outcome as { allRiskAssessments?: unknown }).allRiskAssessments;
    expect(getAssessmentForAction(outcome, 'action-1')).toBe(selected);
  });

  it('returns null when allRiskAssessments is missing AND the legacy field does not match', () => {
    // Asking for a non-selected candidate on a legacy outcome → null,
    // signalling the caller should fall back to a DB read via
    // decisionRepositoryAdapter.getRiskAssessment(actionId).
    const outcome = mkOutcome({ riskAssessment: mkAssessment('action-1') });
    delete (outcome as { allRiskAssessments?: unknown }).allRiskAssessments;
    expect(getAssessmentForAction(outcome, 'action-2')).toBeNull();
  });

  it('returns null when allRiskAssessments is an empty array', () => {
    const outcome = mkOutcome({ allRiskAssessments: [] });
    expect(getAssessmentForAction(outcome, 'action-1')).toBeNull();
  });

  it('prefers allRiskAssessments over riskAssessment when both are populated', () => {
    // The new field is the source of truth. If both somehow disagree
    // (a future bug that fails to keep them in sync), we should trust
    // the per-candidate snapshot, not the convenience pointer.
    const fresh = mkAssessment('action-1', RiskTier.HIGH);
    const stale = mkAssessment('action-1', RiskTier.LOW);
    const outcome = mkOutcome({
      allRiskAssessments: [fresh],
      riskAssessment: stale,
    });
    expect(getAssessmentForAction(outcome, 'action-1')).toBe(fresh);
    expect(getAssessmentForAction(outcome, 'action-1')?.overallTier).toBe(RiskTier.HIGH);
  });
});
