import type { ActionPolicy } from '@skytwin/shared-types';

/**
 * Built-in safety policies that ship with SkyTwin.
 * These cannot be disabled by users and provide baseline safety guarantees.
 */

const now = new Date();

/**
 * Block any financial action when the user has not configured spend limits.
 */
export const NO_SPEND_WITHOUT_LIMIT: ActionPolicy = {
  id: 'builtin_no_spend_without_limit',
  name: 'No Spend Without Limit',
  description:
    'Prevents any financial action from being auto-executed unless the user ' +
    'has configured spend limits in their autonomy settings.',
  rules: [
    {
      id: 'rule_spend_limit_required',
      policyId: 'builtin_no_spend_without_limit',
      condition: {
        field: 'estimatedCostCents',
        operator: 'gt',
        value: 0,
      },
      effect: 'deny',
      reason:
        'Financial actions require configured spend limits. Please set a spend limit in your autonomy settings.',
    },
  ],
  priority: 100,
  enabled: true,
  builtIn: true,
  createdAt: now,
  updatedAt: now,
};

/**
 * Require approval for irreversible actions above low risk.
 */
export const NO_IRREVERSIBLE_WITHOUT_APPROVAL: ActionPolicy = {
  id: 'builtin_no_irreversible_without_approval',
  name: 'No Irreversible Without Approval',
  description:
    'Requires explicit user approval for any action that is irreversible ' +
    'and has risk above "low".',
  rules: [
    {
      id: 'rule_irreversible_approval',
      policyId: 'builtin_no_irreversible_without_approval',
      condition: {
        field: 'reversible',
        operator: 'eq',
        value: false,
      },
      effect: 'require_approval',
      reason:
        'This action cannot be undone. Approval is required for irreversible actions with elevated risk.',
    },
  ],
  priority: 95,
  enabled: true,
  builtIn: true,
  createdAt: now,
  updatedAt: now,
};

/**
 * Block actions with legal sensitivity above moderate.
 */
export const NO_LEGAL_WITHOUT_REVIEW: ActionPolicy = {
  id: 'builtin_no_legal_without_review',
  name: 'No Legal Without Review',
  description:
    'Blocks any action that has legal sensitivity rated above "moderate". ' +
    'These actions require human review.',
  rules: [
    {
      id: 'rule_legal_review',
      policyId: 'builtin_no_legal_without_review',
      condition: {
        field: 'riskDimension.legal_sensitivity',
        operator: 'gt',
        value: 'moderate',
      },
      effect: 'deny',
      reason:
        'Actions with significant legal implications cannot be auto-executed. ' +
        'Please review this action manually.',
    },
  ],
  priority: 90,
  enabled: true,
  builtIn: true,
  createdAt: now,
  updatedAt: now,
};

/**
 * Block actions that could expose private data.
 */
export const NO_PRIVACY_VIOLATIONS: ActionPolicy = {
  id: 'builtin_no_privacy_violations',
  name: 'No Privacy Violations',
  description:
    'Prevents any action that could expose private user data to ' +
    'unauthorized parties.',
  rules: [
    {
      id: 'rule_privacy_protection',
      policyId: 'builtin_no_privacy_violations',
      condition: {
        field: 'riskDimension.privacy_sensitivity',
        operator: 'gt',
        value: 'low',
      },
      effect: 'deny',
      reason:
        'This action may expose private data. Privacy-sensitive actions require explicit approval.',
    },
  ],
  priority: 100,
  enabled: true,
  builtIn: true,
  createdAt: now,
  updatedAt: now,
};

/**
 * Require higher trust tiers for more autonomous actions.
 */
export const TRUST_TIER_GATING: ActionPolicy = {
  id: 'builtin_trust_tier_gating',
  name: 'Trust Tier Gating',
  description:
    'Requires progressively higher trust tiers for actions with increasing ' +
    'risk. Observer tier can only observe; suggest tier can suggest; etc.',
  rules: [
    {
      id: 'rule_observer_no_execute',
      policyId: 'builtin_trust_tier_gating',
      condition: {
        field: 'trustTier',
        operator: 'eq',
        value: 'observer',
      },
      effect: 'deny',
      reason: 'Observer trust tier does not permit any autonomous actions.',
    },
    {
      id: 'rule_suggest_approval',
      policyId: 'builtin_trust_tier_gating',
      condition: {
        field: 'trustTier',
        operator: 'eq',
        value: 'suggest',
      },
      effect: 'require_approval',
      reason: 'Suggest trust tier requires approval for all actions.',
    },
  ],
  priority: 100,
  enabled: true,
  builtIn: true,
  createdAt: now,
  updatedAt: now,
};

/**
 * All built-in policies.
 */
export const DEFAULT_POLICIES: ActionPolicy[] = [
  NO_SPEND_WITHOUT_LIMIT,
  NO_IRREVERSIBLE_WITHOUT_APPROVAL,
  NO_LEGAL_WITHOUT_REVIEW,
  NO_PRIVACY_VIOLATIONS,
  TRUST_TIER_GATING,
];
