import { createHmac } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { sessionRepository } from '@skytwin/db';

const SESSION_SECRET = process.env['SESSION_SECRET'] ?? 'skytwin-dev-secret';
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Hash a raw token with HMAC-SHA256 so we never store the raw token server-side.
 */
export function hashToken(token: string): string {
  return createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

/**
 * Check if a request originates from localhost (bypass auth).
 */
function isLocalhost(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Session auth middleware.
 *
 * - Localhost requests pass through without auth.
 * - Remote requests must include `Authorization: Bearer <token>`.
 * - Auto-refreshes sessions within 1 day of expiry.
 */
export async function sessionAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Localhost bypass
  if (isLocalhost(req)) {
    next();
    return;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Authentication required',
      message: 'Scan the QR code from your desktop to connect.',
    });
    return;
  }

  const token = authHeader.slice(7);
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
