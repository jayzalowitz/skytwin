import type { PolicyDecision } from './policy-evaluator.js';

/**
 * Minimal server shape needed for zero-trust policy logic.
 * Matches the zero_trust_mode field on McpServerRow in @skytwin/db without
 * creating a cross-package import that would introduce a circular dependency.
 */
export interface ZeroTrustServerShape {
  zero_trust_mode: boolean;
}

/**
 * Base risk modifier applied to all MCP host adapter actions.
 * Matches MCP_HOST_TRUST_PROFILE.riskModifier in @skytwin/execution-router.
 */
const MCP_HOST_BASE_RISK_MODIFIER = 1;

/**
 * Additional risk modifier applied when zero-trust mode is enabled on a server.
 * Stacks on top of MCP_HOST_BASE_RISK_MODIFIER, yielding an effective modifier of 2.
 */
const ZERO_TRUST_RISK_MODIFIER_DELTA = 1;

/**
 * Return the effective risk modifier for an MCP server.
 *
 * - Normal server: 1 (MCP_HOST_TRUST_PROFILE base)
 * - Zero-trust enabled: 2 (base + delta)
 *
 * The delta is additive; it does not replace the base modifier.
 * Container-level network isolation is enforced by the desktop app (#180).
 */
export function getEffectiveRiskModifier(server: ZeroTrustServerShape): number {
  return MCP_HOST_BASE_RISK_MODIFIER + (server.zero_trust_mode ? ZERO_TRUST_RISK_MODIFIER_DELTA : 0);
}

/**
 * Produce a PolicyDecision that forces approval for every action on a
 * zero-trust-enabled server.
 *
 * Called by callers that want to enforce the zero-trust override before
 * running the normal policy pipeline.  Returns null when zero-trust is
 * disabled so the normal path proceeds unchanged.
 */
export function applyZeroTrustOverride(
  server: ZeroTrustServerShape,
): PolicyDecision | null {
  if (!server.zero_trust_mode) {
    return null;
  }
  return {
    allowed: true,
    requiresApproval: true,
    reason:
      'Zero-trust mode is enabled for this capability. ' +
      'All actions require explicit approval regardless of trust tier.',
  };
}
