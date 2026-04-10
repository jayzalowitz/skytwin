import { createHmac } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { sessionRepository } from '@skytwin/db';

// Extend Express Request to carry authenticated identity
declare global {
  namespace Express {
    interface Request {
      /** The userId from the validated session. Undefined when dev bypass is active. */
      authenticatedUserId?: string;
      /** The sessionId from the validated session. */
      authenticatedSessionId?: string;
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
      console.warn(
        '[auth] Localhost auth bypass is ACTIVE. Set SKYTWIN_DEV_AUTH_BYPASS=false or NODE_ENV=production to require real auth.',
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
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : queryToken;

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
