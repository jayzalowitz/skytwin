import { Router } from 'express';
import type { Briefing, BriefingItem } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

/**
 * Create the briefings router.
 *
 * GET  /briefings/:userId             — Get latest briefing
 * PUT  /briefings/:userId/preferences — Update briefing preferences
 */
export function createBriefingsRouter(): Router {
  const router = Router();

  /**
   * GET /api/v1/briefings/:userId
   *
   * Return the latest briefing for the given user.
   * Scaffold: returns mock briefing data with sample BriefingItems.
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      // Scaffold: return mock briefing with sample items
      const sampleItems: BriefingItem[] = [
        {
          actionDescription: 'Auto-archived 3 promotional emails from known senders',
          domain: 'email',
          confidence: ConfidenceLevel.HIGH,
          urgency: 'low',
          reasoning: 'You have consistently archived promotional emails from these senders over the past 30 days.',
          wouldAutoExecute: true,
          decisionId: 'dec_mock_001',
        },
        {
          actionDescription: 'Calendar conflict detected: Team standup overlaps with dentist appointment',
          domain: 'calendar',
          confidence: ConfidenceLevel.CONFIRMED,
          urgency: 'high',
          reasoning: 'Two events overlap on Wednesday 10:00-10:30. The dentist appointment was booked first.',
          wouldAutoExecute: false,
          decisionId: 'dec_mock_002',
        },
      ];

      const briefing: Briefing = {
        id: `briefing_${userId}_${Date.now()}`,
        userId,
        scanId: `scan_${Date.now()}`,
        items: sampleItems,
        emailSent: false,
        createdAt: new Date(),
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
   * Scaffold: accept and acknowledge the update.
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

      // Scaffold: acknowledge the update (no persistence yet)
      res.json({ updated: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
