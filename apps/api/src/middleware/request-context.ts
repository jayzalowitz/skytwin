import type { Request, Response, NextFunction } from 'express';
import { runWithRequestContext } from '@skytwin/db';

/**
 * Resolve the authoritative userId for a request from the request itself.
 *
 * Order of preference:
 *   1. `req.authenticatedUserId` — set by `sessionAuth` from the validated
 *      session. This is the trusted identity in real-auth mode.
 *   2. The `:userId` route param — used in dev-bypass mode, where there is no
 *      authenticated identity but ownership middleware has already verified the
 *      param is acceptable (or is being skipped because bypass is active).
 *
 * Body/query userId are deliberately NOT used here: those are arbitrary caller
 * input, and binding the request context to attacker-controlled values would
 * defeat the purpose of the assertion in `@skytwin/db`. When neither source is
 * available (e.g. catalog endpoints with no user scope) we return undefined and
 * the request runs with no context — the db-layer assertion fails open in that
 * case, which is correct: there is no user to mismatch against.
 */
function resolveContextUserId(req: Request): string | undefined {
  if (typeof req.authenticatedUserId === 'string' && req.authenticatedUserId) {
    return req.authenticatedUserId;
  }
  const params = req.params ?? {};
  if (typeof params['userId'] === 'string' && params['userId']) {
    return params['userId'];
  }
  return undefined;
}

/**
 * Middleware that installs the request-scoped `AsyncLocalStorage` context
 * (#408) for the remainder of the request when a userId can be resolved.
 *
 * MUST be mounted AFTER `sessionAuth` (so `req.authenticatedUserId` is set) and
 * AFTER `requireOwnership` (so a cross-user request has already been rejected
 * with a 403 before we'd ever install a context). With those upstream, the
 * context this installs is the user the request is legitimately acting as, and
 * any deep db callee handed a different userId trips `assertUserContext`.
 *
 * The downstream chain — including the async route handlers and every repo call
 * they make — is invoked inside `runWithRequestContext`, so `next()` and all of
 * its continuations observe the context. When no userId resolves, we simply
 * `next()` with no context installed (catalog / unscoped routes).
 */
export function requestContext(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const userId = resolveContextUserId(req);
  if (!userId) {
    next();
    return;
  }
  runWithRequestContext({ userId }, () => {
    next();
  });
}
