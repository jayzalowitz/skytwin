import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware that enforces the authenticated user owns the requested :userId resource.
 *
 * - If `req.authenticatedUserId` is set (real auth), it must match `req.params.userId`.
 * - If `req.authenticatedUserId` is undefined (dev bypass active), the check is skipped.
 *
 * Apply this to any router that uses `:userId` in its path.
 */
export function requireOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const paramUserId = req.params['userId'];
  const authUserId = req.authenticatedUserId;

  // Dev bypass mode — no authenticated identity, skip ownership check
  if (authUserId === undefined) {
    next();
    return;
  }

  // No :userId in route params — nothing to enforce (e.g. /api/feedback)
  if (!paramUserId) {
    next();
    return;
  }

  if (authUserId !== paramUserId) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have access to this resource.',
    });
    return;
  }

  next();
}
