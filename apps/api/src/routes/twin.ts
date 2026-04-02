import { Router } from 'express';
import { TwinService } from '@skytwin/twin-model';
import { TwinRepositoryAdapter, PatternRepositoryAdapter } from '@skytwin/db';
import { ConfidenceLevel } from '@skytwin/shared-types';

/**
 * Create the twin management router.
 */
export function createTwinRouter(): Router {
  const router = Router();
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());

  /**
   * GET /api/twin/export/:userId
   *
   * Export the complete twin profile as JSON or Markdown.
   * Query param: ?format=json (default) or ?format=markdown
   *
   * NOTE: This route must be defined before /:userId to avoid
   * Express matching "export" as a userId parameter.
   */
  router.get('/export/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const format = (req.query['format'] as string) === 'markdown' ? 'markdown' : 'json';
      const exportData = await twinService.exportTwin(userId, format);

      if (format === 'markdown') {
        const markdown = twinService.formatAsMarkdown(exportData);
        res.setHeader('Content-Type', 'text/markdown');
        res.send(markdown);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.json(exportData);
      }
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/twin/:userId
   *
   * Get the current twin profile for a user.
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const profile = await twinService.getOrCreateProfile(userId);

      res.json({
        profile: {
          id: profile.id,
          userId: profile.userId,
          version: profile.version,
          preferencesCount: profile.preferences.length,
          inferencesCount: profile.inferences.length,
          preferences: profile.preferences,
          inferences: profile.inferences,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/twin/:userId/preferences
   *
   * Update preferences for a user's twin profile.
   */
  router.put('/:userId/preferences', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const body = req.body as {
        domain: string;
        key: string;
        value: unknown;
        confidence?: string;
        source?: string;
      };

      if (!body.domain || !body.key) {
        res.status(400).json({ error: 'Missing required fields: domain, key' });
        return;
      }

      const preference = {
        id: `pref_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        domain: body.domain,
        key: body.key,
        value: body.value,
        confidence: (body.confidence as ConfidenceLevel) ?? ConfidenceLevel.MODERATE,
        source: (body.source as 'explicit' | 'inferred' | 'default' | 'corrected') ?? 'explicit',
        evidenceIds: [] as string[],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedProfile = await twinService.updatePreference(userId, preference);

      res.json({
        profile: {
          id: updatedProfile.id,
          version: updatedProfile.version,
          preferencesCount: updatedProfile.preferences.length,
        },
        updatedPreference: preference,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
