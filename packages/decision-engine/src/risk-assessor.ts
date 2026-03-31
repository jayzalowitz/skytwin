import type {
  CandidateAction,
  RiskAssessment,
  DimensionAssessment,
} from '@skytwin/shared-types';
import { RiskDimension, RiskTier } from '@skytwin/shared-types';

/**
 * The RiskAssessor evaluates candidate actions across all risk dimensions
 * and produces a comprehensive risk assessment.
 */
export class RiskAssessor {
  /**
   * Assess a candidate action across all risk dimensions.
   */
  assess(action: CandidateAction): RiskAssessment {
    const dimensions: Record<RiskDimension, DimensionAssessment> = {
      [RiskDimension.REVERSIBILITY]: this.assessReversibility(action),
      [RiskDimension.FINANCIAL_IMPACT]: this.assessFinancialImpact(action),
      [RiskDimension.LEGAL_SENSITIVITY]: this.assessLegalSensitivity(action),
      [RiskDimension.PRIVACY_SENSITIVITY]: this.assessPrivacySensitivity(action),
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: this.assessRelationshipSensitivity(action),
      [RiskDimension.OPERATIONAL_RISK]: this.assessOperationalRisk(action),
    };

    const overallTier = this.calculateOverallTier(dimensions);
    const reasoning = this.buildReasoning(dimensions, overallTier);

    return {
      actionId: action.id,
      overallTier,
      dimensions,
      reasoning,
      assessedAt: new Date(),
    };
  }

  // ── Dimension assessors ──────────────────────────────────────────

  /**
   * Assess reversibility risk. Irreversible actions are inherently riskier.
   */
  assessReversibility(action: CandidateAction): DimensionAssessment {
    if (action.reversible) {
      return {
        tier: RiskTier.NEGLIGIBLE,
        score: 0.1,
        reasoning: 'Action is reversible and can be undone if needed.',
      };
    }

    // Irreversible actions get higher risk based on what they do
    const actionType = action.actionType.toLowerCase();

    if (
      actionType.includes('delete') ||
      actionType.includes('cancel') ||
      actionType.includes('terminate')
    ) {
      return {
        tier: RiskTier.HIGH,
        score: 0.85,
        reasoning: 'Action is irreversible and involves deletion or cancellation.',
      };
    }

    if (
      actionType.includes('send') ||
      actionType.includes('submit') ||
      actionType.includes('publish')
    ) {
      return {
        tier: RiskTier.MODERATE,
        score: 0.6,
        reasoning: 'Action is irreversible and involves sending/publishing content.',
      };
    }

    return {
      tier: RiskTier.MODERATE,
      score: 0.5,
      reasoning: 'Action is irreversible.',
    };
  }

  /**
   * Assess financial impact based on estimated cost.
   */
  assessFinancialImpact(action: CandidateAction): DimensionAssessment {
    const costCents = action.estimatedCostCents;

    if (costCents <= 0) {
      return {
        tier: RiskTier.NEGLIGIBLE,
        score: 0.0,
        reasoning: 'No financial impact.',
      };
    }

    if (costCents <= 500) {
      return {
        tier: RiskTier.LOW,
        score: 0.2,
        reasoning: `Minor financial impact: $${(costCents / 100).toFixed(2)}.`,
      };
    }

    if (costCents <= 2500) {
      return {
        tier: RiskTier.MODERATE,
        score: 0.5,
        reasoning: `Moderate financial impact: $${(costCents / 100).toFixed(2)}.`,
      };
    }

    if (costCents <= 10000) {
      return {
        tier: RiskTier.HIGH,
        score: 0.8,
        reasoning: `Significant financial impact: $${(costCents / 100).toFixed(2)}.`,
      };
    }

    return {
      tier: RiskTier.CRITICAL,
      score: 1.0,
      reasoning: `Major financial impact: $${(costCents / 100).toFixed(2)}. This requires careful review.`,
    };
  }

  /**
   * Assess legal sensitivity based on action type and parameters.
   */
  assessLegalSensitivity(action: CandidateAction): DimensionAssessment {
    const actionType = action.actionType.toLowerCase();
    const description = action.description.toLowerCase();
    const combined = `${actionType} ${description}`;

    const legalKeywords = [
      'contract', 'agreement', 'legal', 'binding', 'terms',
      'liability', 'warranty', 'indemnity', 'compliance',
    ];

    const matchCount = legalKeywords.filter((kw) => combined.includes(kw)).length;

    if (matchCount === 0) {
      return {
        tier: RiskTier.NEGLIGIBLE,
        score: 0.0,
        reasoning: 'No legal implications detected.',
      };
    }

    if (matchCount <= 1) {
      return {
        tier: RiskTier.LOW,
        score: 0.25,
        reasoning: 'Minor potential legal relevance detected.',
      };
    }

    if (matchCount <= 3) {
      return {
        tier: RiskTier.MODERATE,
        score: 0.55,
        reasoning: `Moderate legal sensitivity: matches keywords [${legalKeywords.filter((kw) => combined.includes(kw)).join(', ')}].`,
      };
    }

    return {
      tier: RiskTier.HIGH,
      score: 0.85,
      reasoning: 'High legal sensitivity detected. Human review strongly recommended.',
    };
  }

  /**
   * Assess privacy sensitivity based on action type and data involved.
   */
  assessPrivacySensitivity(action: CandidateAction): DimensionAssessment {
    const actionType = action.actionType.toLowerCase();
    const description = action.description.toLowerCase();
    const combined = `${actionType} ${description}`;

    const privacyKeywords = [
      'personal', 'private', 'confidential', 'ssn', 'password',
      'credential', 'medical', 'health', 'financial_data',
      'share', 'forward', 'expose', 'publish',
    ];

    const matchCount = privacyKeywords.filter((kw) => combined.includes(kw)).length;

    // Check if action involves sharing/forwarding data
    const isSharing =
      actionType.includes('share') ||
      actionType.includes('forward') ||
      actionType.includes('send');

    if (matchCount === 0 && !isSharing) {
      return {
        tier: RiskTier.NEGLIGIBLE,
        score: 0.0,
        reasoning: 'No privacy implications detected.',
      };
    }

    if (isSharing && matchCount === 0) {
      return {
        tier: RiskTier.LOW,
        score: 0.2,
        reasoning: 'Action involves sharing data but no sensitive content detected.',
      };
    }

    if (matchCount <= 2) {
      return {
        tier: RiskTier.MODERATE,
        score: 0.5,
        reasoning: 'Potential privacy implications detected in action content.',
      };
    }

    return {
      tier: RiskTier.HIGH,
      score: 0.85,
      reasoning: 'High privacy sensitivity detected. This action may expose private data.',
    };
  }

  /**
   * Assess relationship sensitivity (e.g., sending a reply that might
   * damage a professional relationship).
   */
  assessRelationshipSensitivity(action: CandidateAction): DimensionAssessment {
    const actionType = action.actionType.toLowerCase();
    const description = action.description.toLowerCase();
    const combined = `${actionType} ${description}`;

    const relationshipKeywords = [
      'decline', 'reject', 'cancel_meeting', 'ignore',
      'unsubscribe', 'block', 'remove', 'unfriend',
      'escalate', 'complain', 'criticize',
    ];

    const positiveKeywords = [
      'accept', 'confirm', 'thank', 'acknowledge', 'approve',
    ];

    const negativeMatchCount = relationshipKeywords.filter((kw) =>
      combined.includes(kw),
    ).length;

    const positiveMatchCount = positiveKeywords.filter((kw) =>
      combined.includes(kw),
    ).length;

    if (negativeMatchCount === 0) {
      if (positiveMatchCount > 0) {
        return {
          tier: RiskTier.NEGLIGIBLE,
          score: 0.0,
          reasoning: 'Action appears relationship-positive.',
        };
      }
      return {
        tier: RiskTier.NEGLIGIBLE,
        score: 0.05,
        reasoning: 'No relationship sensitivity detected.',
      };
    }

    if (negativeMatchCount === 1) {
      return {
        tier: RiskTier.LOW,
        score: 0.3,
        reasoning: 'Minor potential relationship impact detected.',
      };
    }

    if (negativeMatchCount <= 3) {
      return {
        tier: RiskTier.MODERATE,
        score: 0.55,
        reasoning: 'Moderate relationship sensitivity. Action may affect a professional or personal relationship.',
      };
    }

    return {
      tier: RiskTier.HIGH,
      score: 0.8,
      reasoning: 'High relationship sensitivity. This action could significantly impact a relationship.',
    };
  }

  /**
   * Assess operational risk (e.g., changing system settings, modifying
   * workflows, affecting availability).
   */
  assessOperationalRisk(action: CandidateAction): DimensionAssessment {
    const actionType = action.actionType.toLowerCase();
    const description = action.description.toLowerCase();
    const combined = `${actionType} ${description}`;

    const operationalKeywords = [
      'config', 'setting', 'deploy', 'migrate', 'restart',
      'shutdown', 'update_system', 'permission', 'access',
      'integration', 'workflow', 'automation',
    ];

    const matchCount = operationalKeywords.filter((kw) =>
      combined.includes(kw),
    ).length;

    if (matchCount === 0) {
      return {
        tier: RiskTier.NEGLIGIBLE,
        score: 0.0,
        reasoning: 'No operational risk detected.',
      };
    }

    if (matchCount === 1) {
      return {
        tier: RiskTier.LOW,
        score: 0.25,
        reasoning: 'Minor operational implications.',
      };
    }

    if (matchCount <= 3) {
      return {
        tier: RiskTier.MODERATE,
        score: 0.55,
        reasoning: 'Moderate operational risk. Action affects system configuration or workflows.',
      };
    }

    return {
      tier: RiskTier.HIGH,
      score: 0.8,
      reasoning: 'High operational risk. This action could significantly impact system operations.',
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Calculate overall risk tier from individual dimension assessments.
   * The overall tier is the maximum tier across all dimensions, but
   * multiple moderate-risk dimensions can elevate to high.
   */
  private calculateOverallTier(
    dimensions: Record<RiskDimension, DimensionAssessment>,
  ): RiskTier {
    const tiers = Object.values(dimensions).map((d) => d.tier);
    const tierRanks: Record<RiskTier, number> = {
      [RiskTier.NEGLIGIBLE]: 0,
      [RiskTier.LOW]: 1,
      [RiskTier.MODERATE]: 2,
      [RiskTier.HIGH]: 3,
      [RiskTier.CRITICAL]: 4,
    };

    const maxRank = Math.max(...tiers.map((t) => tierRanks[t]));

    // If multiple dimensions are moderate or above, elevate
    const moderateOrAboveCount = tiers.filter(
      (t) => tierRanks[t] >= tierRanks[RiskTier.MODERATE],
    ).length;

    if (moderateOrAboveCount >= 3 && maxRank < tierRanks[RiskTier.HIGH]) {
      return RiskTier.HIGH;
    }

    const rankToTier: Record<number, RiskTier> = {
      0: RiskTier.NEGLIGIBLE,
      1: RiskTier.LOW,
      2: RiskTier.MODERATE,
      3: RiskTier.HIGH,
      4: RiskTier.CRITICAL,
    };

    return rankToTier[maxRank] ?? RiskTier.MODERATE;
  }

  /**
   * Build a human-readable reasoning string from dimension assessments.
   */
  private buildReasoning(
    dimensions: Record<RiskDimension, DimensionAssessment>,
    overallTier: RiskTier,
  ): string {
    const significantDimensions = Object.entries(dimensions)
      .filter(([, assessment]) => assessment.tier !== RiskTier.NEGLIGIBLE)
      .map(([dimension, assessment]) => `${dimension}: ${assessment.tier} - ${assessment.reasoning}`)
      .join('; ');

    if (!significantDimensions) {
      return `Overall risk: ${overallTier}. No significant risk factors identified.`;
    }

    return `Overall risk: ${overallTier}. Risk factors: ${significantDimensions}`;
  }
}
