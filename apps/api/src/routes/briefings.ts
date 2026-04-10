import { Router } from 'express';
import type { Briefing, BriefingItem } from '@skytwin/shared-types';
import {
  proactiveScanRepository,
  userRepository,
} from '@skytwin/db';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

/**
 * Create the briefings router.
 *
 * GET  /briefings/:userId             — Get latest briefing
 * PUT  /briefings/:userId/preferences — Update briefing preferences
 */
export function createBriefingsRouter(): Router {
  const router = Router();
  bindUserIdParamOwnership(router);

  /**
   * GET /api/v1/briefings/:userId
   *
   * Return the latest briefing for the given user.
   * Queries the briefings table via proactiveScanRepository.
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const row = await proactiveScanRepository.getLatestBriefing(userId);

      if (!row) {
        // No briefings exist yet — return an empty briefing
        const emptyBriefing: Briefing = {
          id: `briefing_empty_${userId}`,
          userId,
          items: [],
          emailSent: false,
          createdAt: new Date(),
        };
        res.json({ briefing: emptyBriefing });
        return;
      }

      const briefing: Briefing = {
        id: row.id,
        userId: row.user_id,
        scanId: row.scan_id ?? undefined,
        items: (row.items ?? []) as BriefingItem[],
        emailSent: row.email_sent,
        createdAt: row.created_at,
      };

      res.json({ briefing });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/v1/briefings/:userId/preferences
   *
   * Update the user's briefing preferences.
   * Persists to the user's autonomy_settings in the users table.
   */
  router.put('/:userId/preferences', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const body = req.body as Record<string, unknown>;

      // Validate optional fields have correct types when present
      if (body['schedule'] !== undefined && typeof body['schedule'] !== 'string') {
        res.status(400).json({ error: 'schedule must be a string' });
        return;
      }
      if (body['emailDigest'] !== undefined && typeof body['emailDigest'] !== 'boolean') {
        res.status(400).json({ error: 'emailDigest must be a boolean' });
        return;
      }
      if (body['quietHoursStart'] !== undefined && typeof body['quietHoursStart'] !== 'string') {
        res.status(400).json({ error: 'quietHoursStart must be a string' });
        return;
      }
      if (body['quietHoursEnd'] !== undefined && typeof body['quietHoursEnd'] !== 'string') {
        res.status(400).json({ error: 'quietHoursEnd must be a string' });
        return;
      }

      // Fetch current user to merge briefing preferences into autonomy_settings
      const user = await userRepository.findById(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const currentSettings = (user.autonomy_settings ?? {}) as Record<string, unknown>;
      const briefingPrefs: Record<string, unknown> = {
        ...(currentSettings['briefingPreferences'] as Record<string, unknown> ?? {}),
      };

      if (body['schedule'] !== undefined) briefingPrefs['schedule'] = body['schedule'];
      if (body['emailDigest'] !== undefined) briefingPrefs['emailDigest'] = body['emailDigest'];
      if (body['quietHoursStart'] !== undefined) briefingPrefs['quietHoursStart'] = body['quietHoursStart'];
      if (body['quietHoursEnd'] !== undefined) briefingPrefs['quietHoursEnd'] = body['quietHoursEnd'];

      const updatedSettings = { ...currentSettings, briefingPreferences: briefingPrefs };
      await userRepository.updateAutonomySettings(userId, updatedSettings);

      res.json({ updated: true, briefingPreferences: briefingPrefs });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
