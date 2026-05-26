import { RiskTier, TrustTier } from './enums.js';

/**
 * Audit record for trust tier changes.
 */
export interface TrustTierAudit {
  id: string;
  userId: string;
  oldTier: TrustTier;
  newTier: TrustTier;
  direction: 'promotion' | 'regression';
  triggerReason: string;
  evidence: TierChangeEvidence;
  createdAt: Date;
}

/**
 * Evidence snapshot attached to a trust tier change.
 */
export interface TierChangeEvidence {
  totalApprovals: number;
  totalRejections: number;
  consecutiveApprovals: number;
  approvalRatio: number;
  recentRejections: number;
  windowDays: number;
  hasCriticalUndo: boolean;
}

/**
 * Statistics about a user's approval history, used by the tier engine.
 */
export interface ApprovalStats {
  totalApprovals: number;
  totalRejections: number;
  totalUndos: number;
  consecutiveApprovals: number;
  /** Rejections in the rolling window (default 7 days) */
  recentRejections: number;
  /** Whether any undo with severity 'critical' exists in the window */
  hasCriticalUndo: boolean;
  /** approvals / (approvals + rejections), 0-1 */
  approvalRatio: number;
  /**
   * Hours the user has been at their current trust tier, derived from
   * the latest `trust_tier_audit` row (or user creation time if no
   * audit row exists). Used to enforce the temporal floor on tier
   * promotion (#373) — "consistent feedback over time" means the count
   * threshold and the time floor BOTH have to clear before promotion.
   *
   * Optional for backward compatibility — callers that omit it disable
   * the temporal floor (older code paths or tests where the audit table
   * isn't reachable). Production callers should always populate it.
   */
  hoursInCurrentTier?: number;
}

/**
 * Result of evaluating whether a tier change should happen.
 */
export interface TierEvaluation {
  shouldChange: boolean;
  currentTier: TrustTier;
  recommendedTier?: TrustTier;
  reason: string;
  direction?: 'promotion' | 'regression';
}

/**
 * Promotion thresholds — single source of truth shared between the
 * policy engine, the /api/twin/:userId/progress endpoint, and the web
 * dashboard's trust-progress UI.
 *
 * Why single-source-of-truth: this object previously lived in three
 * places (`packages/policy-engine/src/trust-tier-engine.ts`, the API
 * progress route, and `apps/web/public/js/pages/dashboard.js`). The
 * three drifted — the API + dashboard fabricated a
 * `moderate_autonomy: 100` entry, but the engine intentionally has no
 * automatic moderate→high promotion ("requires explicit opt-in"). The
 * dashboard fired a "You've unlocked Full autopilot" toast at 100
 * approvals that the engine would never honor.
 *
 * MODERATE_AUTONOMY is intentionally absent — promotion to HIGH_AUTONOMY
 * requires explicit user opt-in.
 */
export interface PromotionThreshold {
  consecutiveApprovals: number;
  minApprovalRatio: number;
  /**
   * Minimum hours the user must have spent in the current tier before
   * promotion eligibility, independent of the approval count (#373).
   * "Consistent feedback over time" — twenty approvals in two weeks
   * demonstrates calibration; twenty approvals in twenty minutes
   * demonstrates that the user clicked through quickly. The time floor
   * is the second half of the criterion the original threshold table
   * named but never enforced.
   */
  minDurationInTierHours: number;
  nextTier: TrustTier;
}

export const PROMOTION_THRESHOLDS: Record<string, PromotionThreshold> = {
  [TrustTier.OBSERVER]: {
    consecutiveApprovals: 10,
    minApprovalRatio: 0.8,
    minDurationInTierHours: 24,
    nextTier: TrustTier.SUGGEST,
  },
  [TrustTier.SUGGEST]: {
    consecutiveApprovals: 20,
    minApprovalRatio: 0.85,
    minDurationInTierHours: 72,
    nextTier: TrustTier.LOW_AUTONOMY,
  },
  [TrustTier.LOW_AUTONOMY]: {
    consecutiveApprovals: 50,
    minApprovalRatio: 0.9,
    minDurationInTierHours: 168,
    nextTier: TrustTier.MODERATE_AUTONOMY,
  },
};

/**
 * Display labels for the next-tier promotion. Mirrors the shape of
 * PROMOTION_THRESHOLDS so the UI can render "Bump to <label>" without
 * its own enum-to-string mapping.
 */
export const TIER_DISPLAY_LABELS: Record<string, string> = {
  [TrustTier.OBSERVER]: 'Watch & Suggest',
  [TrustTier.SUGGEST]: 'Ask me first',
  [TrustTier.LOW_AUTONOMY]: 'Handle small stuff',
  [TrustTier.MODERATE_AUTONOMY]: 'Handle most things',
  [TrustTier.HIGH_AUTONOMY]: 'Full autopilot',
};

/**
 * A policy that governs whether an action is allowed.
 */
export interface ActionPolicy {
  id: string;
  name: string;
  description: string;
  rules: PolicyRule[];
  priority: number;
  enabled: boolean;
  builtIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A single rule within a policy.
 */
export interface PolicyRule {
  id: string;
  policyId: string;
  condition: PolicyCondition;
  effect: 'allow' | 'deny' | 'require_approval';
  reason: string;
}

/**
 * A condition that a rule matches against.
 */
export interface PolicyCondition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'contains';
  value: unknown;
}

/**
 * Approval request generated when an action requires human approval.
 */
export interface ApprovalRequest {
  id: string;
  userId: string;
  decisionId: string;
  actionId: string;
  reason: string;
  riskTier: RiskTier;
  trustTier: TrustTier;
  expiresAt: Date;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  respondedAt?: Date;
  createdAt: Date;
}
