import type {
  ActionPolicy,
  CandidateAction,
  RiskAssessment,
  AutonomySettings,
} from '@skytwin/shared-types';
import { RiskTier, TrustTier } from '@skytwin/shared-types';
import { DEFAULT_POLICIES } from './default-policies.js';

/**
 * Port interface for policy persistence.
 *
 * Business logic depends on this interface, not on a concrete database
 * implementation. Adapters (e.g., wrapping @skytwin/db's policyRepository)
 * satisfy this contract at composition time.
 */
export interface PolicyRepositoryPort {
  getAllPolicies(): Promise<ActionPolicy[]>;
  getEnabledPolicies(): Promise<ActionPolicy[]>;
  getPolicy(policyId: string): Promise<ActionPolicy | null>;
  getPoliciesByDomain(domain: string): Promise<ActionPolicy[]>;
  savePolicy(policy: ActionPolicy): Promise<ActionPolicy>;
  updatePolicy(policy: ActionPolicy): Promise<ActionPolicy>;
  deletePolicy(policyId: string): Promise<void>;
}

/**
 * Result of a policy evaluation.
 */
export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  blockingPolicy?: ActionPolicy;
}

/**
 * The PolicyEvaluator checks candidate actions against all applicable policies
 * and user autonomy settings to determine whether an action is allowed,
 * requires approval, or is blocked.
 */
export class PolicyEvaluator {
  constructor(private readonly repository: PolicyRepositoryPort) {}

  /**
   * Evaluate a candidate action against all applicable policies and the
   * user's trust tier.
   */
  async evaluate(
    action: CandidateAction,
    policies: ActionPolicy[],
    trustTier: TrustTier,
    riskAssessment?: RiskAssessment,
    autonomySettings?: AutonomySettings,
  ): Promise<PolicyDecision> {
    // Merge built-in policies with user/provided policies
    const allPolicies = [...DEFAULT_POLICIES, ...policies]
      .filter((p) => p.enabled)
      .sort((a, b) => b.priority - a.priority);

    // Check trust tier gating first
    const tierDecision = this.checkTrustTierGating(action, trustTier, riskAssessment);
    if (tierDecision && !tierDecision.allowed) {
      return tierDecision;
    }

    // Check autonomy settings if provided
    if (autonomySettings) {
      const settingsDecision = this.checkAutonomySettings(action, autonomySettings, riskAssessment);
      if (settingsDecision && !settingsDecision.allowed) {
        return settingsDecision;
      }
    }

    // Check quiet hours — escalate auto-execute to approval (not blocking urgent escalations)
    if (autonomySettings) {
      const quietDecision = this.checkQuietHours(autonomySettings);
      if (quietDecision) {
        return quietDecision;
      }
    }

    // Evaluate each policy's rules
    let requiresApproval = false;
    let approvalReason = '';

    for (const policy of allPolicies) {
      const result = this.evaluatePolicy(action, policy, trustTier, riskAssessment);

      if (result === 'deny') {
        return {
          allowed: false,
          requiresApproval: false,
          reason: `Blocked by policy "${policy.name}": ${policy.description}`,
          blockingPolicy: policy,
        };
      }

      if (result === 'require_approval') {
        requiresApproval = true;
        approvalReason = `Approval required by policy "${policy.name}": ${policy.description}`;
      }
    }

    if (requiresApproval || (tierDecision && tierDecision.requiresApproval)) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: approvalReason || tierDecision?.reason || 'Approval required by policy.',
      };
    }

    return {
      allowed: true,
      requiresApproval: false,
      reason: 'All policies passed. Action is allowed for auto-execution.',
    };
  }

  /**
   * Check if a candidate action's cost is within spend limits.
   */
  checkSpendLimit(
    action: CandidateAction,
    settings: AutonomySettings,
  ): boolean {
    if (action.estimatedCostCents <= 0) {
      return true;
    }
    return action.estimatedCostCents <= settings.maxSpendPerActionCents;
  }

  /**
   * Check if an irreversible action should be allowed based on risk assessment.
   */
  checkReversibility(
    action: CandidateAction,
    riskAssessment: RiskAssessment,
  ): boolean {
    if (action.reversible) {
      return true;
    }

    // Irreversible actions are only allowed if the overall risk is negligible or low
    return (
      riskAssessment.overallTier === RiskTier.NEGLIGIBLE ||
      riskAssessment.overallTier === RiskTier.LOW
    );
  }

  /**
   * Check if the action's domain is in the user's allowlist.
   */
  checkDomainAllowlist(
    domain: string,
    settings: AutonomySettings,
  ): boolean {
    // If blocked domains are specified, check those first
    if (settings.blockedDomains.length > 0) {
      if (settings.blockedDomains.includes(domain)) {
        return false;
      }
    }

    // If allowed domains are specified, domain must be in the list
    if (settings.allowedDomains.length > 0) {
      return settings.allowedDomains.includes(domain);
    }

    // If neither is specified, all domains are allowed
    return true;
  }

  /**
   * Load all enabled policies from the repository, combined with built-in ones.
   */
  async loadPolicies(): Promise<ActionPolicy[]> {
    const userPolicies = await this.repository.getEnabledPolicies();
    return [...DEFAULT_POLICIES, ...userPolicies];
  }

  // ── Private helpers ──────────────────────────────────────────────

  private evaluatePolicy(
    action: CandidateAction,
    policy: ActionPolicy,
    trustTier: TrustTier,
    riskAssessment?: RiskAssessment,
  ): 'allow' | 'deny' | 'require_approval' | null {
    for (const rule of policy.rules) {
      if (this.ruleMatches(action, rule.condition, trustTier, riskAssessment)) {
        return rule.effect;
      }
    }
    return null;
  }

  private ruleMatches(
    action: CandidateAction,
    condition: { field: string; operator: string; value: unknown },
    trustTier: TrustTier,
    riskAssessment?: RiskAssessment,
  ): boolean {
    const fieldValue = this.resolveField(action, condition.field, trustTier, riskAssessment);

    if (fieldValue === undefined) {
      return false;
    }

    return this.compareValues(fieldValue, condition.operator, condition.value);
  }

  private resolveField(
    action: CandidateAction,
    field: string,
    trustTier: TrustTier,
    riskAssessment?: RiskAssessment,
  ): unknown {
    // Special fields
    if (field === 'trustTier') return trustTier;
    if (field === 'overallRiskTier') return riskAssessment?.overallTier;

    // Risk dimension fields
    if (field.startsWith('riskDimension.') && riskAssessment) {
      const dimension = field.replace('riskDimension.', '');
      const dimAssessment = riskAssessment.dimensions[dimension as keyof typeof riskAssessment.dimensions];
      return dimAssessment?.tier;
    }

    // Action fields
    const actionRecord = action as unknown as Record<string, unknown>;
    return actionRecord[field];
  }

  private compareValues(
    actual: unknown,
    operator: string,
    expected: unknown,
  ): boolean {
    // For risk tier comparisons
    if (this.isRiskTierString(actual) && this.isRiskTierString(expected)) {
      const actualRank = this.riskTierRank(actual as string);
      const expectedRank = this.riskTierRank(expected as string);

      switch (operator) {
        case 'eq': return actualRank === expectedRank;
        case 'neq': return actualRank !== expectedRank;
        case 'gt': return actualRank > expectedRank;
        case 'gte': return actualRank >= expectedRank;
        case 'lt': return actualRank < expectedRank;
        case 'lte': return actualRank <= expectedRank;
        default: return false;
      }
    }

    switch (operator) {
      case 'eq': return actual === expected;
      case 'neq': return actual !== expected;
      case 'gt': return (actual as number) > (expected as number);
      case 'gte': return (actual as number) >= (expected as number);
      case 'lt': return (actual as number) < (expected as number);
      case 'lte': return (actual as number) <= (expected as number);
      case 'in': return Array.isArray(expected) && expected.includes(actual);
      case 'not_in': return Array.isArray(expected) && !expected.includes(actual);
      case 'contains':
        return typeof actual === 'string' && actual.includes(expected as string);
      default:
        return false;
    }
  }

  private checkTrustTierGating(
    _action: CandidateAction,
    trustTier: TrustTier,
    riskAssessment?: RiskAssessment,
  ): PolicyDecision | null {
    switch (trustTier) {
      case TrustTier.OBSERVER:
        return {
          allowed: false,
          requiresApproval: false,
          reason: 'Observer trust tier does not permit any autonomous actions.',
        };

      case TrustTier.SUGGEST:
        return {
          allowed: true,
          requiresApproval: true,
          reason: 'Suggest trust tier requires approval for all actions.',
        };

      case TrustTier.LOW_AUTONOMY:
        if (riskAssessment && this.riskTierRank(riskAssessment.overallTier) > this.riskTierRank(RiskTier.LOW)) {
          return {
            allowed: true,
            requiresApproval: true,
            reason: 'Low autonomy tier requires approval for actions above low risk.',
          };
        }
        return null;

      case TrustTier.MODERATE_AUTONOMY:
        if (riskAssessment && this.riskTierRank(riskAssessment.overallTier) > this.riskTierRank(RiskTier.MODERATE)) {
          return {
            allowed: true,
            requiresApproval: true,
            reason: 'Moderate autonomy tier requires approval for actions above moderate risk.',
          };
        }
        return null;

      case TrustTier.HIGH_AUTONOMY:
        if (riskAssessment && riskAssessment.overallTier === RiskTier.CRITICAL) {
          return {
            allowed: true,
            requiresApproval: true,
            reason: 'Even high autonomy tier requires approval for critical-risk actions.',
          };
        }
        return null;

      default:
        // Unrecognized trust tier must be denied — fail closed
        return {
          allowed: false,
          requiresApproval: true,
          reason: `Unrecognized trust tier "${trustTier}". Defaulting to deny.`,
        };
    }
  }

  private checkAutonomySettings(
    action: CandidateAction,
    settings: AutonomySettings,
    riskAssessment?: RiskAssessment,
  ): PolicyDecision | null {
    // Check domain allowlist
    if (!this.checkDomainAllowlist(action.domain, settings)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Domain "${action.domain}" is not in the allowed domains list.`,
      };
    }

    // Check spend limits
    if (!this.checkSpendLimit(action, settings)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason:
          `Action cost (${action.estimatedCostCents} cents) exceeds per-action ` +
          `spend limit (${settings.maxSpendPerActionCents} cents).`,
      };
    }

    // Check reversibility
    if (
      riskAssessment &&
      settings.requireApprovalForIrreversible &&
      !action.reversible
    ) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: 'User settings require approval for irreversible actions.',
      };
    }

    return null;
  }

  /**
   * Check if the current time falls within quiet hours.
   * Escalates auto-execute to approval but does not block.
   * Handles midnight wrap-around (e.g. 22:00 → 07:00).
   */
  private checkQuietHours(
    settings: AutonomySettings,
  ): PolicyDecision | null {
    if (!settings.quietHoursStart || !settings.quietHoursEnd) {
      return null;
    }

    if (!isWithinQuietHours(settings.quietHoursStart, settings.quietHoursEnd)) {
      return null;
    }

    return {
      allowed: true,
      requiresApproval: true,
      reason: `Quiet hours active (${settings.quietHoursStart}–${settings.quietHoursEnd}). Action escalated to approval.`,
    };
  }

  private isRiskTierString(value: unknown): boolean {
    const tiers = ['negligible', 'low', 'moderate', 'high', 'critical'];
    return typeof value === 'string' && tiers.includes(value);
  }

  private riskTierRank(tier: string): number {
    const ranks: Record<string, number> = {
      negligible: 0,
      low: 1,
      moderate: 2,
      high: 3,
      critical: 4,
    };
    return ranks[tier] ?? -1;
  }
}

/**
 * Check if the current time is within a quiet hours window.
 * Handles midnight wrap-around (e.g. start=22:00, end=07:00).
 *
 * @param start - HH:MM format
 * @param end - HH:MM format
 * @param now - optional Date for testing
 */
export function isWithinQuietHours(start: string, end: string, now?: Date): boolean {
  const current = now ?? new Date();
  const currentMinutes = current.getHours() * 60 + current.getMinutes();
  const startMinutes = parseTimeToMinutes(start);
  const endMinutes = parseTimeToMinutes(end);

  if (startMinutes <= endMinutes) {
    // Normal range (e.g. 09:00 - 17:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Midnight wrap (e.g. 22:00 - 07:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}
