import {
  normalizeMemoryActionAdapterName,
  type AdapterTrustProfile,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import { isIronClawEnhancedAdapter } from '@skytwin/ironclaw-adapter';

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
  reversibilityGuarantee: 'none', // rollback() always fails — do not claim partial
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
 * Trust profile for the MCP host adapter (Capability Acquisition Loop, #173).
 *
 * MCP servers can be community-published, so we treat the surface as
 * partially-reversible (some servers expose paired undo tools, most don't)
 * and add a small risk modifier. Per-server zero-trust isolation (#183)
 * tightens this further when enabled by the user.
 */
export const MCP_HOST_TRUST_PROFILE: AdapterTrustProfile = {
  name: 'mcp-host',
  reversibilityGuarantee: 'partial',
  authModel: 'oauth',
  auditTrail: true,
  riskModifier: 1,
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
  private readonly entryRevisions = new Map<string, number>();
  private nextRevision = 1;

  /**
   * Register an adapter with its trust profile.
   */
  register(
    name: string,
    adapter: IronClawAdapter,
    trustProfile: AdapterTrustProfile,
    skills?: Set<string>,
  ): void {
    if (normalizeMemoryActionAdapterName(name) !== name) {
      throw new Error('Adapter name must be a canonical non-credential identifier.');
    }
    this.entries.set(name, { adapter, trustProfile: { ...trustProfile } });
    this.entryRevisions.set(name, this.nextRevision++);
    if (skills) {
      this.adapterSkills.set(name, new Set(skills));
    } else {
      this.adapterSkills.delete(name);
    }
  }

  /**
   * Get an adapter entry by name.
   */
  get(name: string): AdapterEntry | undefined {
    const entry = this.entries.get(name);
    return entry ? { adapter: entry.adapter, trustProfile: { ...entry.trustProfile } } : undefined;
  }

  /** Monotonic identity for the exact adapter/profile/skills registration. */
  getRevision(name: string): number | undefined {
    return this.entryRevisions.get(name);
  }

  /**
   * Get all registered adapter entries.
   */
  getAll(): Map<string, AdapterEntry> {
    return new Map([...this.entries].map(([name, entry]) => [name, {
      adapter: entry.adapter,
      trustProfile: { ...entry.trustProfile },
    }]));
  }

  /**
   * Check if a registered adapter implements the enhanced IronClaw API.
   */
  isEnhanced(name: string): boolean {
    const entry = this.entries.get(name);
    return entry ? isIronClawEnhancedAdapter(entry.adapter) : false;
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
