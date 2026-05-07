import { TrustTier } from './enums.js';

/**
 * Represents a SkyTwin user and their autonomy settings.
 */
export interface User {
  id: string;
  email: string;
  displayName: string;
  trustTier: TrustTier;
  autonomySettings: AutonomySettings;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Per-app override of autonomy boundaries (Capability Acquisition Loop, #173).
 *
 * Keyed by registry id (e.g. "@modelcontextprotocol/server-notion").
 * The user-global cap in {@link AutonomySettings} is the upper bound;
 * per-app overrides may only narrow autonomy, never widen beyond the global.
 * Hard rails (FS denylist, resource caps, audit log) are not subject to overrides.
 */
export interface PerAppOverride {
  /** Tighter per-action cap. If unset, inherits user-global. */
  maxSpendPerActionCents?: number;
  /** Tighter daily cap. If unset, inherits user-global. */
  maxDailySpendCents?: number;
  /** Optional monthly cap with optional rollover (#183). */
  maxMonthlySpendCents?: number;
  /** Whether unspent monthly budget rolls over to the next month. */
  monthlyRollover?: boolean;
  /** Override the global irreversible-requires-approval flag (only stricter). */
  requireApprovalForIrreversible?: boolean;
  /** Run this app's MCP server in zero-trust isolation (#183). */
  zeroTrustMode?: boolean;
}

/**
 * User-configured autonomy boundaries.
 */
export interface AutonomySettings {
  /** Maximum spend per action in cents */
  maxSpendPerActionCents: number;
  /** Maximum daily spend in cents */
  maxDailySpendCents: number;
  /** Domains where autonomous action is allowed */
  allowedDomains: string[];
  /** Domains explicitly blocked from autonomous action */
  blockedDomains: string[];
  /** Whether to require approval for irreversible actions */
  requireApprovalForIrreversible: boolean;
  /** Quiet hours during which no autonomous actions execute */
  quietHoursStart?: string;
  quietHoursEnd?: string;
  /**
   * Per-app overrides keyed by registry id. Overrides may only narrow
   * autonomy; the global caps above are always the upper bound.
   */
  perAppOverrides?: Record<string, PerAppOverride>;
}
