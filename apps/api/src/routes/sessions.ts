import { Router } from 'express';
import { randomUUID } from 'crypto';
import { sessionRepository } from '@skytwin/db';
import { hashToken } from '../middleware/session-auth.js';
import { sessionAuth } from '../middleware/session-auth.js';
import { requireOwnership } from '../middleware/require-ownership.js';
import {
  issuePairingToken,
  consumePairingToken,
} from '../pairing-token-store.js';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Create the sessions management router.
 * Used for QR code pairing and session management.
 */
export function createSessionsRouter(): Router {
  const router = Router();

  /**
   * POST /api/sessions
   *
   * Mint a SHORT-LIVED pairing token + return the QR URL the mobile
   * client should scan (#385). Pre-fix this route minted a 7-day
   * session token and embedded it directly in the QR — a screenshot
   * granted indefinite pairing and multiple devices could redeem
   * in parallel. Now: the QR carries a 5-minute pairing token that
   * the mobile client exchanges for a real session via
   * `POST /api/sessions/pair/consume`. Same response shape so
   * existing Settings UI code keeps working — the `token` field is
   * the pairing token, `qrUrl` uses `pairToken=` in the query string
   * to signal the new semantics, and `expiresAt` is now 5 minutes.
   */
  router.post('/', async (req, res, next) => {
    try {
      const body = req.body as { userId: string; deviceName?: string };
      if (!body.userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
      }

      const deviceName = body.deviceName ?? 'Phone';
      const { token, expiresAt } = issuePairingToken(body.userId, deviceName);

      // Build the QR URL — point to the web app (not the API) so the mobile
      // browser loads the SPA which calls /sessions/pair/consume and stores
      // the resulting session token. The legacy `token=` param is gone;
      // mobile entry code now branches on `pairToken=`.
      const webPort = parseInt(process.env['WEB_PORT'] ?? '3200', 10);
      const qrUrl = `http://skytwin.local:${webPort}/mobile?pairToken=${encodeURIComponent(token)}&userId=${encodeURIComponent(body.userId)}`;

      res.status(201).json({
        token,
        qrUrl,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/sessions/pair/consume
   *
   * Exchange a pairing token (from a freshly-scanned QR) for a real
   * session token (#385). Single-use: the same pairing token cannot
   * be redeemed twice. Expired tokens return 410; already-used tokens
   * return 409; unknown / never-issued tokens return 404.
   *
   * Unauthenticated by design — the pairing token IS the
   * authorisation, exactly like the legacy `/api/sessions` `token=`
   * URL flow. Possession of a valid (non-expired, non-used) pairing
   * token proves the holder was either issued it or holds the QR
   * within the 5-minute window.
   */
  router.post('/pair/consume', async (req, res, next) => {
    try {
      const body = req.body as { pairToken?: string; deviceName?: string };
      if (!body.pairToken) {
        res.status(400).json({ error: 'Missing pairToken' });
        return;
      }

      const result = consumePairingToken(body.pairToken);
      if (result.kind === 'expired') {
        res.status(410).json({ error: 'code_expired', message: 'This pairing code has expired. Generate a new one.' });
        return;
      }
      if (result.kind === 'already-used') {
        res.status(409).json({ error: 'code_already_used', message: 'This pairing code has already been used.' });
        return;
      }
      if (result.kind === 'unknown') {
        res.status(404).json({ error: 'code_not_found', message: 'Pairing code is unknown.' });
        return;
      }

      // Mint the real session token. Device name from consume body
      // overrides the issue-time default if the mobile client supplied
      // its own (lets a tablet identify itself as "iPad" rather than
      // inheriting the "Phone" default the Settings page sends).
      const sessionToken = `${randomUUID()}-${randomUUID()}`;
      const tokenHash = hashToken(sessionToken);
      const sessionExpiresAt = new Date(Date.now() + SESSION_DURATION_MS);
      const deviceName = (body.deviceName?.trim() || result.deviceName).slice(0, 64);

      const session = await sessionRepository.create({
        userId: result.userId,
        tokenHash,
        deviceName,
        expiresAt: sessionExpiresAt,
      });

      res.status(201).json({
        sessionId: session.id,
        token: sessionToken,
        userId: result.userId,
        expiresAt: sessionExpiresAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/sessions/:userId
   *
   * List active sessions for a user.
   */
  router.get('/:userId', sessionAuth, requireOwnership, async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (typeof userId !== 'string' || !userId) {
        res.status(400).json({ error: 'Missing or invalid userId' });
        return;
      }
      const sessions = await sessionRepository.findActiveByUser(userId);

      res.json({
        sessions: sessions.map((s) => ({
          id: s.id,
          deviceName: s.device_name,
          createdAt: s.created_at,
          expiresAt: s.expires_at,
          lastActiveAt: s.last_active_at,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/sessions/:sessionId
   *
   * Revoke a specific session.
   */
  router.delete('/:sessionId', sessionAuth, requireOwnership, async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const body = req.body as { userId?: string };
      if (typeof sessionId !== 'string' || !sessionId) {
        res.status(400).json({ error: 'Missing or invalid sessionId' });
        return;
      }
      if (!body.userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
      }

      // Verify the session belongs to the requesting user
      const sessions = await sessionRepository.findActiveByUser(body.userId);
      const owns = sessions.some((s) => s.id === sessionId);
      if (!owns) {
        res.status(403).json({ error: 'Session not found or not owned by user' });
        return;
      }

      await sessionRepository.revoke(sessionId);
      res.json({ revoked: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
