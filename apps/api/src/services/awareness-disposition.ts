import {
  SituationType,
  type DecisionObject,
  type DecisionOutcome,
} from '@skytwin/shared-types';

/**
 * Awareness disposition gate (#601 follow-up to the newsletter audit).
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
 * Rollout is flagged + phased: Phase 0 logs `isAwarenessOnly` candidates with
 * no behaviour change; Phase 1 (`AWARENESS_DISPOSITION_GATE=on`) suppresses the
 * approval row.
 */

/** Passive, reversible, zero-cost "file it" actions — no outward effect. */
const PASSIVE_AWARENESS_ACTIONS = new Set<string>([
  'acknowledge',
  'dismiss',
  'create_note',
  'label_email',
  'archive_email',
]);

/**
 * Authoring tiers (#251) that mark mail the user does not need to act on:
 * newsletters, automated/transactional notices, and the user's own sent mail.
 *
 * Human inbound (`inbox_personal` / `inbox_broadcast`) is deliberately EXCLUDED
 * — a 1:1 or cc'd human thread can be important, so it still surfaces as an
 * approval. The gate's job is to remove noise, not to hide correspondence.
 */
const AWARENESS_TIERS = new Set<string>([
  'inbox_newsletter',
  'inbox_automated',
  'user_sent_originated',
  'user_sent_reply',
]);

/**
 * Phase-1 master switch. Default OFF — `AWARENESS_DISPOSITION_GATE=on` enables
 * suppression. (Opposite default from the `ENTITY_LINKING`/`COMMITMENT_EXTRACTION`
 * rollback flags, which default on; this is opt-in until Phase 2.)
 */
export function awarenessDispositionGateEnabled(): boolean {
  return process.env['AWARENESS_DISPOSITION_GATE'] === 'on';
}

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
 *   or a costed action;
 * - human inbound mail (`inbox_personal` / `inbox_broadcast`) or a calendar
 *   invite (`CALENDAR_INVITE`) — those stay approvals.
 */
export function isAwarenessOnly(decision: DecisionObject, outcome: DecisionOutcome): boolean {
  const action = outcome.selectedAction;
  if (!action) return false;

  // Hard safety carve-out: an injection-guard escalation always surfaces,
  // regardless of the action's shape (policy-evaluator never strips this).
  if (outcome.confirmationLevel) return false;

  // Passive, reversible, free action only.
  if (!PASSIVE_AWARENESS_ACTIONS.has(action.actionType)) return false;
  if (!action.reversible) return false;
  if ((action.estimatedCostCents ?? 0) !== 0) return false;
  // Defensive: an action whose zero cost is unverified (costZeroIntent='unknown')
  // is escalated by the cost gate without a confirmationLevel — don't gate it.
  if (action.costZeroIntent === 'unknown') return false;

  // Awareness context: a calendar update/cancellation, or email from an
  // awareness tier (newsletter / automated / the user's own sent mail).
  if (decision.situationType === SituationType.CALENDAR_UPDATE) return true;
  if (decision.situationType === SituationType.EMAIL_TRIAGE) {
    const tier = readAuthoringTier(decision.rawData);
    return tier !== undefined && AWARENESS_TIERS.has(tier);
  }
  return false;
}
