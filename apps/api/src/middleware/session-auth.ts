import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { sessionRepository } from '@skytwin/db';
import { createLogger } from '@skytwin/core';

const log = createLogger('api:auth');

// Extend Express Request to carry authenticated identity
declare global {
  namespace Express {
    interface Request {
      /** The userId from the validated session. Undefined when dev bypass is active. */
      authenticatedUserId?: string;
      /** The sessionId from the validated session. */
      authenticatedSessionId?: string;
      /**
       * True when the request authenticated as the local SkyTwin service
       * (the worker or the idle-miner) via `SKYTWIN_SERVICE_TOKEN` from a
       * loopback address. Never set for a human session.
       */
      serviceAuthenticated?: boolean;
    }
  }
}

const SESSION_SECRET = process.env['SESSION_SECRET'] ?? 'skytwin-dev-secret';
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Whether the dev auth bypass is active.
 *
 * Controlled by SKYTWIN_DEV_AUTH_BYPASS env var.
 * Defaults to true in development, false otherwise.
 */
const DEV_AUTH_BYPASS =
  (process.env['SKYTWIN_DEV_AUTH_BYPASS'] ??
    (process.env['NODE_ENV'] === 'development' ? 'true' : 'false')) === 'true';

let bypassWarned = false;

/**
 * Hash a raw token with HMAC-SHA256 so we never store the raw token server-side.
 */
export function hashToken(token: string): string {
  return createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

/**
 * Constant-time comparison of a presented bearer token against the
 * per-install loopback service token (`SKYTWIN_SERVICE_TOKEN`).
 *
 * The desktop `ServiceManager` mints this value once per installation and
 * hands the same value to the API, the worker, and the idle-miner. It exists
 * because those daemons run under `NODE_ENV=production` in a packaged build,
 * where the dev auth bypass is off and they hold no human session — without a
 * credential every `/api/events/ingest` POST 401s and the product ingests
 * nothing.
 *
 * Read from `process.env` per request (not captured at module load) so a test
 * — or an operator restarting the API with a rotated token — sees the current
 * value. Returns false when the env var is unset or empty: no token
 * configured means no service auth, never "allow everything".
 */
function matchesServiceToken(presented: string): boolean {
  const expected = process.env['SKYTWIN_SERVICE_TOKEN'];
  if (typeof expected !== 'string' || expected.length === 0) return false;

  const presentedBuf = Buffer.from(presented, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  // `timingSafeEqual` THROWS on a length mismatch, so the length guard has to
  // come first. Leaking the token length is not a meaningful oracle: it is a
  // fixed-width 64-char hex string minted by `randomBytes(32)`.
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}

/**
 * Check if a request originates from localhost.
 */
function isLocalhost(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Session auth middleware.
 *
 * - When DEV_AUTH_BYPASS is true AND request is from localhost, auth is skipped.
 * - Otherwise, `Authorization: Bearer <token>` is required.
 * - A bearer token that matches `SKYTWIN_SERVICE_TOKEN` AND arrives from a
 *   loopback address authenticates the local worker / idle-miner. This is a
 *   DISTINCT path from the dev bypass and is available in production.
 * - SSE clients may pass `?token=<token>` because EventSource cannot set headers.
 * - On success, attaches `req.authenticatedUserId` and `req.authenticatedSessionId`.
 * - Auto-refreshes sessions within 1 day of expiry.
 */
export async function sessionAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Dev-only localhost bypass (must be explicitly enabled or NODE_ENV=development)
  if (DEV_AUTH_BYPASS && isLocalhost(req)) {
    if (!bypassWarned) {
      log.warn(
        'Localhost auth bypass is ACTIVE. Set SKYTWIN_DEV_AUTH_BYPASS=false or NODE_ENV=production to require real auth.',
      );
      bypassWarned = true;
    }
    // No authenticatedUserId set — ownership middleware will skip checks in bypass mode
    next();
    return;
  }

  const authHeader = req.headers['authorization'];
  const query = req.query ?? {};
  const queryToken = typeof query['token'] === 'string' ? query['token'] : undefined;
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;
  const token = bearerToken ?? queryToken;

  // Loopback service credential (worker / idle-miner). Deliberately narrower
  // than the human session path: header-only (never `?token=`), and only from
  // 127.0.0.1 / ::1. Both conditions plus a configured, matching secret are
  // required — none of them alone grants anything.
  if (
    bearerToken !== undefined &&
    isLocalhost(req) &&
    matchesServiceToken(bearerToken)
  ) {
    // These daemons forward signals for EVERY user on the install, so there
    // is no single owning identity to bind. We leave `authenticatedUserId`
    // unset and raise an explicit flag instead; `requireOwnership` keys off
    // that flag rather than off the absence of an identity, so the service
    // path stays intentional rather than accidentally inheriting the dev
    // bypass's "no identity means skip the check" behaviour.
    req.serviceAuthenticated = true;
    next();
    return;
  }

  if (!token) {
    res.status(401).json({
      error: 'Authentication required',
      message: 'Scan the QR code from your desktop to connect.',
    });
    return;
  }
  const tokenHash = hashToken(token);

  const session = await sessionRepository.findByTokenHash(tokenHash);
  if (!session) {
    res.status(401).json({
      error: 'Invalid session',
      message: 'Scan the QR code again from your desktop.',
    });
    return;
  }

  // Check expiry
  if (new Date(session.expires_at) < new Date()) {
    res.status(401).json({
      error: 'Session expired',
      message: 'Scan the QR code again from your desktop.',
    });
    return;
  }

  // Attach identity to request
  req.authenticatedUserId = session.user_id;
  req.authenticatedSessionId = session.id;

  // Auto-refresh if within 1 day of expiry
  const timeUntilExpiry = new Date(session.expires_at).getTime() - Date.now();
  if (timeUntilExpiry < REFRESH_WINDOW_MS) {
    await sessionRepository.refreshExpiry(
      session.id,
      new Date(Date.now() + SESSION_DURATION_MS),
    );
  } else {
    await sessionRepository.touchLastActive(session.id);
  }

  next();
}
