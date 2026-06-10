/**
 * Write-scope gate (#spec 11, #485).
 *
 * The decision engine must never PROPOSE (let alone auto-execute) a write action
 * the user never granted permission for. Scopes are stored on
 * `connected_accounts` but were never consulted; this gate closes that. It
 * composes with the injection guard — scope gating answers "are we allowed to
 * attempt this at all", the injection guard answers "is this attempt safe to
 * auto-run".
 *
 * Fail-safe: a scoped write action with empty/unknown granted scopes is treated
 * as NOT granted (mirrors the provenance fail-safe, safety invariant #8).
 */

import type { CandidateAction } from '@skytwin/shared-types';

export interface ScopeRequirement {
  scope: string;
  provider: string;
}

/**
 * The write scope an action shape requires, or null if it isn't a write we gate
 * on a specific scope (those are left to the injection guard / policy engine).
 */
export function requiredWriteScope(actionType: string): ScopeRequirement | null {
  const a = actionType.toLowerCase();
  if (/^send_|reply|compose|^email_send/.test(a)) {
    return { scope: 'gmail.send', provider: 'gmail' };
  }
  if (/(create|update|modify|delete|cancel|move|rsvp).*(event|calendar)|^calendar_/.test(a)) {
    return { scope: 'calendar.events', provider: 'google_calendar' };
  }
  // Invite RSVP actions are calendar writes too (review #5) — they don't contain
  // the literal "event"/"calendar" but they mutate the calendar via the API.
  if (/(accept|decline|tentative)_invite|tentative_accept|propose_alternative|^rsvp|respond_to_event/.test(a)) {
    return { scope: 'calendar.events', provider: 'google_calendar' };
  }
  return null;
}

/**
 * Does the user have the write scope this action requires? True when the action
 * needs no tracked scope. Fail-safe: a required scope absent from `grantedScopes`
 * (including empty/garbage) returns false.
 */
export function hasWriteScope(actionType: string, grantedScopes: string[]): boolean {
  const req = requiredWriteScope(actionType);
  if (!req) return true;
  if (!Array.isArray(grantedScopes) || grantedScopes.length === 0) return false;
  return grantedScopes.some((s) => typeof s === 'string' && s.includes(req.scope));
}

/**
 * Downgrade any candidate whose write scope the user hasn't granted into a
 * human-review "grant access" escalation. Non-write (or properly-scoped)
 * candidates pass through unchanged. The downgraded candidate carries no
 * auto-executable payload.
 */
export function applyScopeGate(
  candidates: CandidateAction[],
  grantedScopes: string[],
): CandidateAction[] {
  return candidates.map((c) => {
    if (hasWriteScope(c.actionType, grantedScopes)) return c;
    const req = requiredWriteScope(c.actionType);
    return {
      ...c,
      actionType: 'escalate_to_user',
      description:
        `Connect write access (${req?.scope ?? 'required permission'}) to enable: ` +
        `${c.description}`,
      parameters: {
        reason: 'missing_write_scope',
        requiredScope: req?.scope ?? null,
        provider: req?.provider ?? null,
        originalActionType: c.actionType,
      },
      estimatedCostCents: 0,
      reversible: true,
      reasoning:
        'Not proposed for auto-execution: the user has not granted the write ' +
        `scope (${req?.scope ?? 'unknown'}) this action requires (spec 11).`,
    };
  });
}
