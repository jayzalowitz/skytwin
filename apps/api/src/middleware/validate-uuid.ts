import type { Router } from 'express';

/**
 * Canonical UUID shape. Six route modules (`memory-config`,
 * `capabilities`, `dxt`, `external-agents`, `twin-briefings`,
 * `assistant`) each had their own copy of this regex before #367 —
 * any divergence between them would mean a UUID accepted by one
 * route would be rejected by another. One source of truth.
 *
 * Permissive on case (UUIDs are hex; CRDB tolerates either) but
 * strict on shape — no extra characters, no whitespace.
 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns true when `value` is a non-empty string matching the
 * canonical UUID shape. Use at route boundaries — body fields,
 * query strings — before passing to pg, so we catch bad input
 * with a clean 400 instead of letting the pg driver throw a
 * "could not parse … as type uuid" message that historically
 * leaked back to clients (#367).
 */
export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Express `router.param` binding that rejects non-UUID `:userId`
 * path segments with a 400 before any route handler runs.
 *
 * Apply this BEFORE `bindUserIdParamOwnership` on every router
 * that mounts a `:userId` segment — validation precedes auth
 * so a malformed value never reaches the ownership check that
 * would otherwise return 403 ("Forbidden" is the wrong error
 * for "you typed a non-UUID into the URL").
 */
export function bindUserIdParamValidator(router: Router): void {
  bindUuidParamValidator(router, 'userId', 'invalid_user_id', 'User ID');
}

/**
 * Register the same fail-fast UUID boundary for any named route parameter.
 * Keep this shared so non-user UUIDs cannot accidentally reach a UUID-typed
 * Cockroach query and turn malformed client input into a server error.
 */
export function bindUuidParamValidator(
  router: Router,
  paramName: string,
  error: string,
  label: string,
): void {
  router.param(paramName, (_req, res, next, value) => {
    if (!isValidUserId(value)) {
      res.status(400).json({
        error,
        message: `${label} must be a UUID.`,
      });
      return;
    }
    next();
  });
}
