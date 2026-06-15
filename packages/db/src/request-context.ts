import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped context that travels across async boundaries.
 *
 * This is the cross-cutting "who is this request acting as?" signal. The API
 * sets it once per request (after `sessionAuth` + ownership middleware have
 * resolved the userId) and any deep callee — including the `@skytwin/db`
 * repository layer — can read it to answer "am I in the right user's
 * context?" without threading `userId` through every intermediate function.
 *
 * #408: defense-in-depth for multi-user isolation. The primary boundary is
 * still the route-layer ownership middleware (`require-ownership.ts`); this
 * store is a backstop that catches a deep callee that was handed the wrong
 * `userId` (a mis-wired service, a swapped variable) while a different user's
 * request is in flight.
 */
export interface RequestContext {
  /**
   * The userId this request is authoritatively acting as. Resolved from the
   * validated session (or the trusted route param in dev bypass), NOT from
   * arbitrary request input.
   */
  userId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `context` installed as the active request context. The context
 * is visible to every async continuation spawned within `fn` and is torn down
 * automatically when `fn` settles. Nesting is allowed — an inner call shadows
 * the outer context for its own subtree only.
 */
export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

/**
 * The active request context, or `undefined` when running outside any request
 * scope (background workers, migrations, seeds, most unit tests).
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The userId of the active request context, or `undefined` when running
 * outside any request scope.
 */
export function getRequestUserId(): string | undefined {
  return storage.getStore()?.userId;
}

/**
 * Thrown when a user-scoped DB operation is invoked with a `userId` that does
 * not match the active request context. This is a cross-user access attempt —
 * a programming error or an exploit, never an expected failure mode — so it is
 * a thrown error (a hard stop), not a typed result object. The message
 * deliberately does NOT echo the expected/actual userIds to the response layer;
 * callers that surface errors to clients must map this to a generic 403/500
 * (the API's global error handler already does — it never leaks `err.message`).
 */
export class UserContextMismatchError extends Error {
  readonly expectedUserId: string;
  readonly actualUserId: string;

  constructor(expectedUserId: string, actualUserId: string) {
    super(
      `Cross-user access blocked: operation for userId ${actualUserId} ran inside the request context of userId ${expectedUserId}.`,
    );
    this.name = 'UserContextMismatchError';
    this.expectedUserId = expectedUserId;
    this.actualUserId = actualUserId;
  }
}

/**
 * Assert that a user-scoped operation's `userId` matches the active request
 * context.
 *
 * Fail-OPEN when there is no active context: background workers, migrations,
 * seeds, and the bulk of the unit-test suite legitimately run with no request
 * scope, and a user-scoped repository call there is not a cross-user attempt.
 * Adding the context is what arms the check — so this is purely additive and
 * cannot break those code paths.
 *
 * Fail-CLOSED when a context IS active and the `userId` mismatches: that is a
 * deep callee operating on the wrong user while another user's request is in
 * flight. Throws {@link UserContextMismatchError}.
 *
 * An empty/missing `userId` argument is left to the caller's own validation
 * (the UUID validator middleware and per-route checks) — this assertion only
 * speaks to cross-user mismatch, not to absent input.
 */
export function assertUserContext(userId: string): void {
  const ctx = storage.getStore();
  // No active request context → not a request-scoped call → nothing to assert.
  if (ctx === undefined) return;
  // Caller passed no userId → not this assertion's concern; let route/UUID
  // validation handle absent input rather than firing a misleading mismatch.
  if (!userId) return;
  if (ctx.userId !== userId) {
    throw new UserContextMismatchError(ctx.userId, userId);
  }
}
