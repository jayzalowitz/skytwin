import { RiskTier } from '@skytwin/shared-types';
import type { RiskAssessment, AdapterTrustProfile } from '@skytwin/shared-types';

/**
 * Ordered list of risk tiers from lowest to highest.
 * Used to compute tier bumps.
 */
const RISK_TIER_ORDER: readonly RiskTier[] = [
  RiskTier.NEGLIGIBLE,
  RiskTier.LOW,
  RiskTier.MODERATE,
  RiskTier.HIGH,
  RiskTier.CRITICAL,
];

/**
 * Bump a risk tier up by the given number of levels, capping at CRITICAL.
 */
function bumpTier(tier: RiskTier, levels: number): RiskTier {
  const currentIndex = RISK_TIER_ORDER.indexOf(tier);
  if (currentIndex === -1) {
    return tier;
  }
  const newIndex = Math.min(currentIndex + levels, RISK_TIER_ORDER.length - 1);
  return RISK_TIER_ORDER[newIndex]!;
}

/**
 * Apply adapter-specific risk adjustments to a risk assessment.
 *
 * If the action is irreversible AND the adapter's trust profile has a positive
 * riskModifier, the overall risk tier is bumped up by that many levels.
 *
 * Returns a new RiskAssessment; the original is never mutated.
 */
export function applyAdapterRiskModifier(
  riskAssessment: RiskAssessment,
  trustProfile: AdapterTrustProfile,
  isIrreversible: boolean,
): RiskAssessment {
  if (!isIrreversible || trustProfile.riskModifier <= 0) {
    // No modification needed — return a shallow copy to maintain immutability contract
    return { ...riskAssessment };
  }

  const bumpedTier = bumpTier(riskAssessment.overallTier, trustProfile.riskModifier);

  return {
    ...riskAssessment,
    overallTier: bumpedTier,
    reasoning: `${riskAssessment.reasoning} [Adapter risk modifier: +${trustProfile.riskModifier} tier(s) applied for irreversible action via ${trustProfile.name}]`,
  };
}
