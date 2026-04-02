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
