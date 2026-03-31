import { RiskTier, TrustTier } from './enums.js';

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
