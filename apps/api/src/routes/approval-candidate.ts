import type { CandidateAction } from '@skytwin/shared-types';

/**
 * Serialize a selected action into the `approval_requests.candidateAction` JSON.
 *
 * SINGLE source of truth for what an approval row stores about its action, so
 * the safety-critical fields cannot drift between the three approval paths
 * (events ingest x2, assistant chat). They DID drift: two of the three dropped
 * `costZeroIntent`, and on reload `parseCostZeroIntent(undefined)` is treated as
 * legacy `verified_zero` (decision.ts) — letting an `'unknown'`-cost action clear
 * the spend fast-path after approval (the #372 bypass surface). `provenance`
 * round-trips too so the injection guard re-evaluates against the real origin
 * rather than the untrusted-external fail-safe default. `id` is preserved so the
 * approve handler can relink the decision-maker's stored RiskAssessment (#371).
 *
 * Anything an approve-time re-evaluation of the `CandidateAction` depends on MUST
 * be added here, not at an individual call site.
 */
export function serializeApprovalCandidate(
  action: CandidateAction,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: action.id,
    actionType: action.actionType,
    description: action.description,
    domain: action.domain,
    parameters,
    estimatedCostCents: action.estimatedCostCents,
    costZeroIntent: action.costZeroIntent,
    provenance: action.provenance,
    reversible: action.reversible,
    confidence: action.confidence,
    reasoning: action.reasoning,
  };
}
