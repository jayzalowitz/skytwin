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
}
