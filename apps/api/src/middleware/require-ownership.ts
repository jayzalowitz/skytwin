import type { Request, Response, NextFunction, Router } from 'express';

/**
 * Middleware that enforces the authenticated user owns the requested user-scoped resource.
 *
 * - If `req.authenticatedUserId` is set (real auth), it must match the userId
 *   requested via route params, request body, or query string.
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
