import type { Request, Response, NextFunction, Router } from 'express';

/**
 * Middleware that enforces the authenticated user owns the requested user-scoped resource.
 *
 * - If `req.authenticatedUserId` is set (real auth), it must match the userId
 *   requested via route params, request body, or query string.
 * - If `req.serviceAuthenticated` is true (loopback service credential), the
 *   check is skipped — the local worker legitimately acts for every user.
 * - If `req.authenticatedUserId` is undefined (dev bypass active), the check is skipped.
 *
 * Apply this to any router that scopes data by userId, regardless of where that
 * userId is supplied.
 */
function extractRequestedUserId(req: Request): string | undefined {
  const params = req.params ?? {};
  if (typeof params['userId'] === 'string' && params['userId']) {
    return params['userId'];
  }

  if (
    req.body &&
    typeof req.body === 'object' &&
    typeof (req.body as Record<string, unknown>)['userId'] === 'string'
  ) {
    return (req.body as Record<string, string>)['userId'];
  }

  const query = req.query ?? {};
  if (typeof query['userId'] === 'string' && query['userId']) {
    return query['userId'];
  }

  return undefined;
}

function enforceOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
  requestedUserId?: string,
): void {
  // Loopback service credential (worker / idle-miner), set ONLY by
  // `sessionAuth` after a constant-time match on `SKYTWIN_SERVICE_TOKEN` from
  // 127.0.0.1 / ::1. These daemons poll connectors for every user on the
  // install and forward each signal with that user's id in the body, so there
  // is no single owning identity to match against. Checked EXPLICITLY, before
  // the dev-bypass branch below, so the service path does not silently depend
  // on "no identity means skip" — tightening that branch later must not
  // require rediscovering that the worker relied on it.
  if (req.serviceAuthenticated === true) {
    next();
    return;
  }

  const authUserId = req.authenticatedUserId;

  // Dev bypass mode — no authenticated identity, skip ownership check
  if (authUserId === undefined) {
    next();
    return;
  }

  // No userId in params/query/body — nothing to enforce.
  if (!requestedUserId) {
    next();
    return;
  }

  if (authUserId !== requestedUserId) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have access to this resource.',
    });
    return;
  }

  next();
}

export function requireOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  enforceOwnership(req, res, next, extractRequestedUserId(req));
}

export function bindUserIdParamOwnership(router: Router): void {
  router.param('userId', (req, res, next, userId) => {
    enforceOwnership(req, res, next, userId);
  });
}
