import {
  SituationType,
  AWARENESS_TIERS,
  awarenessDispositionGateEnabled,
  isPassiveAwarenessShape,
  type DecisionObject,
  type DecisionOutcome,
} from '@skytwin/shared-types';

/**
 * Awareness disposition gate — ingest-route entrypoint (#601).
 *
 * At `observer`/`suggest` tier the policy engine forces `requiresApproval` on
 * EVERY selected action, and the ingest route creates one approval card per
 * signal. That floods the queue with things that are awareness, not decisions:
 * newsletters, automated notices, the user's own sent mail re-ingested, and
 * "no action required" calendar updates. The digest already separates awareness
 * from action at READ time, but only after the approval row exists.
 *
 * This module decides, at WRITE time, whether an outcome is pure awareness so
 * the ingest route can record the decision/explanation (the digest still shows
 * it as FYI) WITHOUT creating an approval row. It is deliberately conservative:
 * it never gates an injection-guard escalation, a non-passive / irreversible /
 * costed action, or human inbound mail.
 *
 * The passive action set, awareness authoring tiers, rollout flag, and the
 * action-shape predicate are shared with the worker's memory-action-loop gate
 * via `@skytwin/shared-types` so the two write paths cannot drift. This file
 * adds only the ingest-route CONTEXT half (situation type + authoring tier).
 *
 * Rollout is flagged + phased: Phase 0 logs `isAwarenessOnly` candidates with
 * no behaviour change; Phase 1 (`AWARENESS_DISPOSITION_GATE=on`) suppresses the
 * approval row.
 */

// Re-export so existing import sites (events.ts) keep a stable path.
export { awarenessDispositionGateEnabled };

/** Read `authoringTier` whether the connector left it top-level or under `data`. */
function readAuthoringTier(rawData: Record<string, unknown> | undefined): string | undefined {
  if (!rawData) return undefined;
  const top = rawData['authoringTier'];
  if (typeof top === 'string') return top;
  const data = rawData['data'];
  if (data && typeof data === 'object') {
    const nested = (data as Record<string, unknown>)['authoringTier'];
    if (typeof nested === 'string') return nested;
  }
  return undefined;
}

/**
 * True when an outcome is pure awareness: a passive, reversible, zero-cost action
 * selected for a newsletter / automated notice / the user's own sent mail / a
 * calendar update — something to be aware of, not a decision to make.
 *
 * NEVER true for:
 * - an injection-guard escalation (`outcome.confirmationLevel` is set) — that is
 *   a security escalation on untrusted content and must always surface;
 * - a non-passive action (reply/schedule/post/execute), an irreversible action,
 *   or a costed action (see `isPassiveAwarenessShape`);
 * - human inbound mail (`inbox_personal` / `inbox_broadcast`) or a calendar
 *   invite (`CALENDAR_INVITE`) — those stay approvals.
 */
export function isAwarenessOnly(decision: DecisionObject, outcome: DecisionOutcome): boolean {
  const action = outcome.selectedAction;
  if (!action) return false;

  // Hard safety carve-out: an injection-guard escalation always surfaces,
  // regardless of the action's shape (policy-evaluator never strips this).
  if (outcome.confirmationLevel) return false;

  // Passive, reversible, verified-free action only (shared shape core).
  if (!isPassiveAwarenessShape(action)) return false;

  // Awareness context: a calendar update/cancellation, or email from an
  // awareness tier (newsletter / automated / the user's own sent mail).
  if (decision.situationType === SituationType.CALENDAR_UPDATE) return true;
  if (decision.situationType === SituationType.EMAIL_TRIAGE) {
    const tier = readAuthoringTier(decision.rawData);
    return tier !== undefined && AWARENESS_TIERS.has(tier);
  }
  return false;
}
