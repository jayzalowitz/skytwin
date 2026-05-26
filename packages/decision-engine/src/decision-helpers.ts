import type { DecisionOutcome, RiskAssessment } from '@skytwin/shared-types';

/**
 * Look up the RiskAssessment for a specific candidate action by id,
 * preferring the in-memory `outcome.allRiskAssessments` snapshot (#412).
 *
 * Returns null when the assessment is absent — either because the
 * outcome predates #412 (no `allRiskAssessments` field) or because the
 * candidate id isn't represented in the snapshot (synthetic outcome,
 * proactive-evaluator response, etc). Callers that need an
 * authoritative answer should fall back to a DB read via
 * `decisionRepositoryAdapter.getRiskAssessment(actionId)` on null —
 * see `apps/api/src/routes/events.ts:559-578` for the pattern.
 *
 * Pre-#412 consumers reached for `outcome.riskAssessment` and assumed
 * it was for the action they cared about. That is unsafe when the
 * selected action and the queried action differ (manual re-selection
 * from the approval queue, future "swap candidate" UX, replay of a
 * persisted outcome). This helper makes the lookup explicit and
 * fail-safe.
 */
export function getAssessmentForAction(
  outcome: DecisionOutcome,
  actionId: string,
): RiskAssessment | null {
  const all = outcome.allRiskAssessments;
  if (!Array.isArray(all) || all.length === 0) {
    // Fall through to the legacy convenience field — it is still
    // correct when the queried action IS the selected one, which
    // covers the auto-execute happy path (#371).
    if (outcome.riskAssessment && outcome.riskAssessment.actionId === actionId) {
      return outcome.riskAssessment;
    }
    return null;
  }
  return all.find((a) => a.actionId === actionId) ?? null;
}
