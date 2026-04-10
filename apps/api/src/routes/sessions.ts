import { Router } from 'express';
import { randomUUID } from 'crypto';
import { sessionRepository } from '@skytwin/db';
import { hashToken } from '../middleware/session-auth.js';

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
   * Create a new session token for mobile pairing.
   * Returns a QR payload (URL with embedded token).
   */
  router.post('/', async (req, res, next) => {
    try {
      const body = req.body as { userId: string; deviceName?: string };
      if (!body.userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
      }

      // Generate a URL-safe token with 128+ bits of entropy
      const rawToken = `${randomUUID()}-${randomUUID()}`;
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

      const session = await sessionRepository.create({
        userId: body.userId,
        tokenHash,
        deviceName: body.deviceName ?? 'Phone',
        expiresAt,
      });

      // Build the QR URL — point to the web app (not the API) so the mobile
      // browser loads the SPA which stores the token and redirects to the dashboard.
      const webPort = parseInt(process.env['WEB_PORT'] ?? '3200', 10);
      const qrUrl = `http://skytwin.local:${webPort}/mobile?token=${encodeURIComponent(rawToken)}&userId=${encodeURIComponent(body.userId)}`;

      res.status(201).json({
        sessionId: session.id,
        token: rawToken,
        qrUrl,
        expiresAt: expiresAt.toISOString(),
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
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
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
  router.delete('/:sessionId', async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const body = req.body as { userId?: string };
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
