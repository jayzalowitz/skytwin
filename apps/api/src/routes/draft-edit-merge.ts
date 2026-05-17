/**
 * Edit-before-approve merge helper for draft-email candidates (#303).
 *
 * The dashboard renders the candidate's `draftBody` in an editable
 * textarea. When the user clicks "Send this draft", the API receives
 * an `editedBody` field alongside the approve POST. This helper
 * decides whether to merge the edit onto the in-flight
 * `CandidateAction.parameters` before policy + execution.
 *
 * Extracted from the inline `approvals.ts:respond` flow so the merge
 * decision has a focused unit test — the route file itself is
 * integration-heavy and resists narrow tests.
 */
import type { CandidateAction } from '@skytwin/shared-types';

export interface MergeDraftEditInput {
  actionType: string;
  editedBody: unknown;
}

/**
 * Decide whether the supplied `editedBody` should override
 * `parameters.draftBody` on a `draft_email` candidate.
 *
 * Returns the new value when override is appropriate, `null`
 * otherwise. Callers apply the returned value as
 * `candidateAction.parameters.draftBody = returned`.
 *
 * Override rules (deliberately strict — only fire when ALL hold):
 *
 *   1. The action MUST be `draft_email`. Other action types ignore
 *      the field even if it shows up in the request — guards against
 *      a misused field accidentally overwriting unrelated parameters.
 *   2. `editedBody` MUST be a string. The dashboard always sends a
 *      string; non-string values (objects, numbers, undefined) are
 *      treated as "no edit supplied."
 *   3. The string MUST have non-whitespace content. A whitespace-
 *      only submission would otherwise blank out a real draft, which
 *      is almost never what the user means — they would Discard
 *      instead.
 */
export function resolveDraftEditOverride(input: MergeDraftEditInput): string | null {
  if (input.actionType !== 'draft_email') return null;
  if (typeof input.editedBody !== 'string') return null;
  if (input.editedBody.trim().length === 0) return null;
  return input.editedBody;
}

/**
 * Apply the merge in-place on a `CandidateAction.parameters` map.
 * Returns true when an override occurred, false otherwise. Useful
 * for tests + observability ("the dashboard edit overrode the
 * stored body for this approval").
 */
export function applyDraftEditOverride(
  candidateAction: CandidateAction,
  editedBody: unknown,
): boolean {
  const merged = resolveDraftEditOverride({
    actionType: candidateAction.actionType,
    editedBody,
  });
  if (merged === null) return false;
  candidateAction.parameters['draftBody'] = merged;
  return true;
}
