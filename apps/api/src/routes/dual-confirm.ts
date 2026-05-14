/**
 * Pure decision logic for the dual-confirmation gate on the approvals
 * `/respond` endpoint — the second half of the documentary-poisoning
 * injection guard.
 *
 * Extreme-severity actions are written with `confirmation_level = 'dual'`.
 * Approving one takes two distinct, token-gated POSTs:
 *
 *   1. First confirmation: no token. The route mints a one-time token and
 *      returns `awaiting_second_confirmation` — nothing executes.
 *   2. Second confirmation: must carry that exact token, within a 10-minute
 *      window. Only then does the route fall through to the normal
 *      approve-and-execute path.
 *
 * This module is the pure classifier: given the stored approval row and the
 * request body, it says which of those steps applies (or that the dual gate
 * does not apply at all). The route does the DB writes and HTTP responses;
 * keeping the branching pure makes it unit-testable without the full route
 * harness.
 */

import { timingSafeEqual } from 'crypto';

/** How long the first confirmation stays valid before the user must restart. */
export const FIRST_CONFIRMATION_WINDOW_MS = 10 * 60 * 1000;

/** The minimal shape of a stored approval row this classifier needs. */
export interface DualConfirmApprovalRow {
  confirmation_level: string;
  status: string;
  first_confirmed_at: Date | string | null;
  confirmation_token: string | null;
}

/** The minimal shape of the `/respond` request body this classifier needs. */
export interface DualConfirmRequestBody {
  action: 'approve' | 'reject';
  confirmationToken?: string;
}

/**
 * The classifier's verdict.
 *
 * - `not-applicable` — single-confirmation request, or a reject action;
 *   the route proceeds with its normal flow.
 * - `issue-first` — first confirmation of a dual request; the route should
 *   call `recordFirstConfirmation` and return the token.
 * - `proceed` — second confirmation is valid; the route falls through to the
 *   normal approve-and-execute path.
 * - `reject` — the request is malformed or stale; the route returns
 *   `httpStatus` + `error`.
 */
export type DualConfirmStep =
  | { kind: 'not-applicable' }
  | { kind: 'issue-first' }
  | { kind: 'proceed' }
  | { kind: 'reject'; httpStatus: number; error: string };

/**
 * Constant-time token comparison. Returns false (rather than throwing) on a
 * length mismatch, so a caller never leaks length information through an
 * exception path.
 */
function tokensMatch(provided: string, expected: string): boolean {
  if (provided.length === 0 || provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * Classify which step of the dual-confirmation flow a `/respond` call is.
 *
 * @param row  The stored approval row (already ownership-checked by the route).
 * @param body The parsed request body (action already validated).
 * @param now  Current epoch ms — injected for deterministic tests.
 */
export function classifyDualConfirmStep(
  row: DualConfirmApprovalRow,
  body: DualConfirmRequestBody,
  now: number = Date.now(),
): DualConfirmStep {
  // The dual gate only applies to approving a dual-confirmation request.
  // Single-confirmation requests and rejects use the normal flow.
  if (row.confirmation_level !== 'dual' || body.action !== 'approve') {
    return { kind: 'not-applicable' };
  }

  // A dual request that is no longer pending cannot be confirmed.
  if (row.status !== 'pending') {
    return {
      kind: 'reject',
      httpStatus: 409,
      error: 'Approval request is no longer pending',
    };
  }

  // No first confirmation yet → this POST is the first one.
  if (!row.first_confirmed_at) {
    return { kind: 'issue-first' };
  }

  // First confirmation already happened → this POST must be the second,
  // carrying the one-time token, within the window.
  const provided = body.confirmationToken ?? '';
  const expected = row.confirmation_token ?? '';
  if (!tokensMatch(provided, expected)) {
    return {
      kind: 'reject',
      httpStatus: 400,
      error:
        'Second confirmation requires the confirmationToken returned by the ' +
        'first confirmation.',
    };
  }

  const firstAt = new Date(row.first_confirmed_at).getTime();
  if (Number.isNaN(firstAt) || now - firstAt > FIRST_CONFIRMATION_WINDOW_MS) {
    return {
      kind: 'reject',
      httpStatus: 410,
      error:
        'The first confirmation expired (10-minute window). Start the approval ' +
        'over to get a fresh token.',
    };
  }

  return { kind: 'proceed' };
}
