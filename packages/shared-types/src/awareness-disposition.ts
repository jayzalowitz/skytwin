/**
 * Awareness disposition — shared core (#601).
 *
 * Two independent write paths can flood the approval queue with things that are
 * awareness, not decisions:
 *
 *  1. the ingest route (`apps/api/src/routes/events.ts`) — one approval per
 *     signal at `observer`/`suggest` tier; and
 *  2. the memory action loop (`apps/worker/src/jobs/memory-action-loop.ts`) —
 *     one approval per memory-derived opportunity at the same tiers.
 *
 * Both need the SAME notion of "is this passive awareness?" so the gate cannot
 * drift between them. This module is that single source of truth: the passive
 * action set, the awareness authoring tiers, the rollout flag, and the
 * action-SHAPE predicate. Each call site layers its own CONTEXT guard on top
 * (the ingest route keys off situation/tier; the worker keys off whether the
 * injection guard escalated) — see each site for the composed check.
 *
 * Deliberately conservative: an action only has the awareness SHAPE when it is
 * passive (no outward effect), reversible, and genuinely free (a verified-zero
 * cost, never an unverified `'unknown'`). Security escalations and outward /
 * irreversible / costed actions never match.
 */

/** Passive, reversible, zero-cost "file it" actions — no outward effect. */
export const PASSIVE_AWARENESS_ACTIONS = new Set<string>([
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
export const AWARENESS_TIERS = new Set<string>([
  'inbox_newsletter',
  'inbox_automated',
  'user_sent_originated',
  'user_sent_reply',
]);

/**
 * Phase-1 master switch. Default OFF — `AWARENESS_DISPOSITION_GATE=on` enables
 * suppression. (Opposite default from the `ENTITY_LINKING`/`COMMITMENT_EXTRACTION`
 * rollback flags, which default on; this is opt-in until Phase 2.)
 *
 * Guarded so importing shared-types into a browser bundle that never calls this
 * (no `process` global) cannot throw — only Node call sites (api/worker) read it.
 */
export function awarenessDispositionGateEnabled(): boolean {
  return typeof process !== 'undefined' && process.env?.['AWARENESS_DISPOSITION_GATE'] === 'on';
}

/** The minimal action fields the shape predicate inspects. */
export interface AwarenessActionShape {
  actionType: string;
  reversible: boolean;
  estimatedCostCents?: number;
  costZeroIntent?: 'verified_zero' | 'unknown';
}

/**
 * True when an action has the pure-awareness SHAPE: a passive action type, that
 * is reversible and genuinely free. This is the shape half of the gate; callers
 * add the security/context half (no injection escalation; the right situation).
 *
 * NEVER true for a non-passive type (reply/schedule/post/execute), an
 * irreversible action, a costed action, or an action whose zero cost is
 * unverified (`costZeroIntent === 'unknown'`) — the cost gate escalates those
 * without a confirmation level, so they must not be silently disposed.
 */
export function isPassiveAwarenessShape(action: AwarenessActionShape): boolean {
  if (!PASSIVE_AWARENESS_ACTIONS.has(action.actionType)) return false;
  if (!action.reversible) return false;
  if ((action.estimatedCostCents ?? 0) !== 0) return false;
  if (action.costZeroIntent === 'unknown') return false;
  return true;
}
