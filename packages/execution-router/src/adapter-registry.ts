import type { AdapterTrustProfile } from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';

/**
 * Entry in the adapter registry: an adapter implementation paired with its trust profile.
 */
export interface AdapterEntry {
  adapter: IronClawAdapter;
  trustProfile: AdapterTrustProfile;
}

/**
 * Pre-defined trust profiles for known adapters.
 */
export const IRONCLAW_TRUST_PROFILE: AdapterTrustProfile = {
  name: 'ironclaw',
  reversibilityGuarantee: 'full',
  authModel: 'hmac',
  auditTrail: true,
  riskModifier: 0,
};

export const OPENCLAW_TRUST_PROFILE: AdapterTrustProfile = {
  name: 'openclaw',
  reversibilityGuarantee: 'partial',
  authModel: 'api_key',
  auditTrail: true,
  riskModifier: 1,
};

export const DIRECT_TRUST_PROFILE: AdapterTrustProfile = {
  name: 'direct',
  reversibilityGuarantee: 'partial',
  authModel: 'none',
  auditTrail: false,
  riskModifier: 0,
};

/**
 * Registry that maps adapter names to their implementation and trust profile.
 *
 * Each adapter is registered with a unique name and an associated trust profile
 * that describes its security characteristics and risk modifiers.
 */
export class AdapterRegistry {
  private readonly entries = new Map<string, AdapterEntry>();
  private readonly adapterSkills = new Map<string, Set<string>>();

  /**
   * Register an adapter with its trust profile.
   */
  register(
    name: string,
    adapter: IronClawAdapter,
    trustProfile: AdapterTrustProfile,
    skills?: Set<string>,
  ): void {
    this.entries.set(name, { adapter, trustProfile });
    if (skills) {
      this.adapterSkills.set(name, skills);
    }
  }

  /**
   * Get an adapter entry by name.
   */
  get(name: string): AdapterEntry | undefined {
    return this.entries.get(name);
  }

  /**
   * Get all registered adapter entries.
   */
  getAll(): Map<string, AdapterEntry> {
    return new Map(this.entries);
  }

  /**
   * Check if a named adapter can handle the given action type.
   * If the adapter has a declared skill set, checks membership.
   * If no skill set is declared, assumes it can handle all action types.
   */
  canHandle(name: string, actionType: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) {
      return false;
    }

    const skills = this.adapterSkills.get(name);
    if (!skills) {
      // No declared skill set — assume it can handle anything
      return true;
    }

    return skills.has(actionType);
  }

  /**
   * Get all adapter names that can handle the given action type.
   */
  getCapableAdapters(actionType: string): string[] {
    const capable: string[] = [];
    for (const [name] of this.entries) {
      if (this.canHandle(name, actionType)) {
        capable.push(name);
      }
    }
    return capable;
  }
}
