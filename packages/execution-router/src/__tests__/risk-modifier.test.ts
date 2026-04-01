import { describe, it, expect } from 'vitest';
import { RiskTier, RiskDimension } from '@skytwin/shared-types';
import type { RiskAssessment, AdapterTrustProfile } from '@skytwin/shared-types';
import { applyAdapterRiskModifier } from '../risk-modifier.js';

// ── Test helpers ─────────────────────────────────────────────────────

function makeRiskAssessment(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    actionId: 'action-1',
    overallTier: RiskTier.LOW,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: { tier: RiskTier.LOW, score: 0.2, reasoning: 'Reversible' },
      [RiskDimension.FINANCIAL_IMPACT]: { tier: RiskTier.NEGLIGIBLE, score: 0, reasoning: 'Free' },
      [RiskDimension.LEGAL_SENSITIVITY]: { tier: RiskTier.NEGLIGIBLE, score: 0, reasoning: 'None' },
      [RiskDimension.PRIVACY_SENSITIVITY]: { tier: RiskTier.LOW, score: 0.1, reasoning: 'Low' },
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: { tier: RiskTier.LOW, score: 0.2, reasoning: 'Low' },
      [RiskDimension.OPERATIONAL_RISK]: { tier: RiskTier.NEGLIGIBLE, score: 0, reasoning: 'None' },
    },
    reasoning: 'Low risk action',
    assessedAt: new Date(),
    ...overrides,
  };
}

function makeTrustProfile(overrides: Partial<AdapterTrustProfile> = {}): AdapterTrustProfile {
  return {
    name: 'test-adapter',
    reversibilityGuarantee: 'partial',
    authModel: 'api_key',
    auditTrail: true,
    riskModifier: 1,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('applyAdapterRiskModifier', () => {
  it('does not modify risk when riskModifier is 0', () => {
    const assessment = makeRiskAssessment({ overallTier: RiskTier.MODERATE });
    const profile = makeTrustProfile({ riskModifier: 0 });

    const result = applyAdapterRiskModifier(assessment, profile, true);

    expect(result.overallTier).toBe(RiskTier.MODERATE);
    expect(result.reasoning).toBe(assessment.reasoning);
  });

  it('bumps risk tier for irreversible actions with riskModifier > 0', () => {
    const assessment = makeRiskAssessment({ overallTier: RiskTier.LOW });
    const profile = makeTrustProfile({ riskModifier: 1 });

    const result = applyAdapterRiskModifier(assessment, profile, true);

    expect(result.overallTier).toBe(RiskTier.MODERATE);
    expect(result.reasoning).toContain('Adapter risk modifier');
    expect(result.reasoning).toContain('+1');
  });

  it('does not bump for reversible actions even with riskModifier > 0', () => {
    const assessment = makeRiskAssessment({ overallTier: RiskTier.LOW });
    const profile = makeTrustProfile({ riskModifier: 1 });

    const result = applyAdapterRiskModifier(assessment, profile, false);

    expect(result.overallTier).toBe(RiskTier.LOW);
    expect(result.reasoning).not.toContain('Adapter risk modifier');
  });

  it('caps at CRITICAL and does not go above', () => {
    const assessment = makeRiskAssessment({ overallTier: RiskTier.HIGH });
    const profile = makeTrustProfile({ riskModifier: 3 });

    const result = applyAdapterRiskModifier(assessment, profile, true);

    expect(result.overallTier).toBe(RiskTier.CRITICAL);
  });

  it('does not mutate the original risk assessment', () => {
    const assessment = makeRiskAssessment({ overallTier: RiskTier.LOW });
    const profile = makeTrustProfile({ riskModifier: 1 });

    const result = applyAdapterRiskModifier(assessment, profile, true);

    expect(result).not.toBe(assessment);
    expect(assessment.overallTier).toBe(RiskTier.LOW);
    expect(result.overallTier).toBe(RiskTier.MODERATE);
  });

  it('bumps by multiple tiers when riskModifier is > 1', () => {
    const assessment = makeRiskAssessment({ overallTier: RiskTier.NEGLIGIBLE });
    const profile = makeTrustProfile({ riskModifier: 2 });

    const result = applyAdapterRiskModifier(assessment, profile, true);

    expect(result.overallTier).toBe(RiskTier.MODERATE);
  });
});
