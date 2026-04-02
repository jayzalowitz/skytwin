import { TrustTier } from '@skytwin/shared-types';

/**
 * A per-domain trust tier override.
 */
export interface DomainAutonomyPolicy {
  domain: string;
  trustTier: TrustTier;
  maxSpendPerActionCents?: number;
}

/**
 * Port interface for domain autonomy persistence.
 */
export interface DomainAutonomyRepositoryPort {
  getForUser(userId: string): Promise<DomainAutonomyPolicy[]>;
  getForDomain(userId: string, domain: string): Promise<DomainAutonomyPolicy | null>;
}

/**
 * Ordered tiers from lowest to highest.
 */
const TIER_RANK: Record<string, number> = {
  [TrustTier.OBSERVER]: 0,
  [TrustTier.SUGGEST]: 1,
  [TrustTier.LOW_AUTONOMY]: 2,
  [TrustTier.MODERATE_AUTONOMY]: 3,
  [TrustTier.HIGH_AUTONOMY]: 4,
};

/**
 * Domain autonomy manager.
 *
 * Resolves the effective trust tier for a given domain by comparing
 * the user's global tier with any domain-specific override. The
 * effective tier is always the MORE RESTRICTIVE of the two.
 */
export class DomainAutonomyManager {
  constructor(private readonly repository: DomainAutonomyRepositoryPort) {}

  /**
   * Get the effective trust tier for a domain.
   * Returns the more restrictive of global and domain-specific tier.
   */
  async getEffectiveTier(
    userId: string,
    domain: string,
    globalTier: TrustTier,
  ): Promise<{ effectiveTier: TrustTier; source: 'global' | 'domain'; domainPolicy?: DomainAutonomyPolicy }> {
    const domainPolicy = await this.repository.getForDomain(userId, domain);

    if (!domainPolicy) {
      return { effectiveTier: globalTier, source: 'global' };
    }

    // Use the more restrictive tier (lower rank = more restrictive)
    const globalRank = TIER_RANK[globalTier] ?? 0;
    const domainRank = TIER_RANK[domainPolicy.trustTier] ?? 0;

    if (domainRank <= globalRank) {
      return {
        effectiveTier: domainPolicy.trustTier,
        source: 'domain',
        domainPolicy,
      };
    }

    return { effectiveTier: globalTier, source: 'global', domainPolicy };
  }

  /**
   * Resolve the effective tier using in-memory policies (no DB call).
   * Useful when policies are already loaded.
   */
  resolveEffectiveTier(
    domain: string,
    globalTier: TrustTier,
    policies: DomainAutonomyPolicy[],
  ): TrustTier {
    const domainPolicy = policies.find((p) => p.domain === domain);
    if (!domainPolicy) return globalTier;

    const globalRank = TIER_RANK[globalTier] ?? 0;
    const domainRank = TIER_RANK[domainPolicy.trustTier] ?? 0;

    return domainRank <= globalRank ? domainPolicy.trustTier : globalTier;
  }
}
