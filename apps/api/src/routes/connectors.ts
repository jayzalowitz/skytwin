import { Router } from 'express';
import { connectorHealthRepository } from '@skytwin/db';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';

/**
 * Connector health surface (#377). One read endpoint so the dashboard
 * can render a "Gmail disconnected — Reconnect" banner when a user's
 * refresh token has been revoked at the OAuth provider or otherwise
 * permanently invalidated. The worker writes the underlying state on
 * every poll outcome — see `pollUser` in apps/worker/src/index.ts.
 */
export function createConnectorsRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);

  /**
   * GET /api/connectors/:userId/status
   *
   * Returns the union of every connector's current health row for the
   * user. Convenience flag `anyNeedsReauth` lets the dashboard short-
   * circuit the banner render without iterating the per-connector map.
   * Users with no connector_health rows (never polled, no connectors
   * configured) return an empty `connectors` map + `anyNeedsReauth:
   * false` — silent for the banner.
   */
  router.get('/:userId/status', async (req, res, next) => {
    try {
      const { userId } = req.params as { userId: string };
      const rows = await connectorHealthRepository.findByUser(userId);
      const connectors: Record<string, {
        status: 'connected' | 'needs_reauth' | 'disabled';
        errorCode: string | null;
        lastSuccessAt: string | null;
        lastFailureAt: string | null;
      }> = {};
      let anyNeedsReauth = false;
      for (const row of rows) {
        connectors[row.connector_name] = {
          status: row.status,
          errorCode: row.error_code,
          lastSuccessAt: row.last_success_at?.toISOString() ?? null,
          lastFailureAt: row.last_failure_at?.toISOString() ?? null,
        };
        if (row.status === 'needs_reauth') anyNeedsReauth = true;
      }
      res.json({ userId, connectors, anyNeedsReauth });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
