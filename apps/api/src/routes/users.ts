import { Router } from 'express';
import { userRepository } from '@skytwin/db';
import { TwinService } from '@skytwin/twin-model';
import { TwinRepositoryAdapter, PatternRepositoryAdapter } from '@skytwin/db';
import { ConfidenceLevel } from '@skytwin/shared-types';
import { sessionAuth } from '../middleware/session-auth.js';
import { requireOwnership } from '../middleware/require-ownership.js';

const VALID_TIERS = ['observer', 'suggest', 'low_autonomy', 'moderate_autonomy', 'high_autonomy'];

const VALID_DOMAINS = [
  'email', 'calendar', 'finance', 'shopping', 'travel',
  'tasks', 'smart_home', 'social', 'documents', 'health',
];

/**
 * Create the users management router.
 */
export function createUsersRouter(): Router {
  const router = Router();
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());

  // Everything under /:userId is user-scoped and must be authenticated.
  router.use('/:userId', sessionAuth, requireOwnership);

  /**
   * POST /api/users
   *
   * Create a new user during onboarding. If a user with the same email
   * already exists, returns the existing user (idempotent).
   */
  router.post('/', async (req, res, next) => {
    try {
      const body = req.body as { name?: string; email?: string };
      const email = body.email?.trim();
      const name = body.name?.trim() || email || 'Anonymous';

      if (!email) {
        res.status(400).json({ error: 'Email is required to create an account.' });
        return;
      }

      // Check if user already exists
      const existing = await userRepository.findByEmail(email);
      if (existing) {
        res.json({ user: existing, created: false });
        return;
      }

      // Trust tier is always 'suggest' for new users — must be earned, not declared.
      // Callers cannot self-escalate via the creation endpoint.
      const trustTier = 'suggest';

      const user = await userRepository.create({
        email,
        name,
        trustTier,
      });

      res.status(201).json({ user, created: true });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/users/:userId
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
      }

      // Try by ID first, then by email
      let user = await userRepository.findById(userId);
      if (!user) {
        user = await userRepository.findByEmail(userId);
      }
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.json({ user });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/users/:userId/trust-tier
   */
  router.put('/:userId/trust-tier', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body as { trustTier: string };

      if (!body.trustTier) {
        res.status(400).json({ error: 'Missing trustTier' });
        return;
      }

      if (!VALID_TIERS.includes(body.trustTier)) {
        res.status(400).json({
          error: `Invalid trust tier. Must be one of: ${VALID_TIERS.join(', ')}`,
        });
        return;
      }

      // Try to update by ID, then by email
      let updated = await userRepository.updateTrustTier(userId, body.trustTier);
      if (!updated) {
        const byEmail = await userRepository.findByEmail(userId);
        if (byEmail) {
          updated = await userRepository.updateTrustTier(byEmail.id, body.trustTier);
        }
      }

      if (!updated) {
        res.status(404).json({ error: 'User not found. Complete setup first.' });
        return;
      }

      res.json({ user: updated });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/users/:userId/domains
   *
   * Save the user's enabled domains to their autonomy_settings JSON.
   */
  router.put('/:userId/domains', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body as { domains?: string[] };

      if (!Array.isArray(body.domains)) {
        res.status(400).json({ error: 'Missing or invalid domains array' });
        return;
      }

      // Filter to valid domain identifiers
      const domains = body.domains.filter((d) => VALID_DOMAINS.includes(d));

      // Look up user (by ID or email)
      let user = await userRepository.findById(userId);
      if (!user) {
        user = await userRepository.findByEmail(userId);
      }
      if (!user) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      // Merge enabledDomains into existing autonomy_settings
      const existing =
        typeof user.autonomy_settings === 'string'
          ? JSON.parse(user.autonomy_settings)
          : user.autonomy_settings ?? {};

      const updated = { ...existing, enabledDomains: domains };
      const result = await userRepository.updateAutonomySettings(user.id, updated);

      res.json({ user: result });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/users/:userId/seed-preferences
   *
   * Accept an array of {domain, key, value} and create Preference records
   * via the twin service so they feed into the decision engine from day one.
   */
  router.post('/:userId/seed-preferences', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body as {
        preferences?: Array<{ domain: string; key: string; value: unknown }>;
      };

      if (!Array.isArray(body.preferences) || body.preferences.length === 0) {
        res.status(400).json({ error: 'Missing or empty preferences array' });
        return;
      }

      // Resolve the real user ID (callers may pass an email)
      let resolvedId = userId;
      const byId = await userRepository.findById(userId);
      if (!byId) {
        const byEmail = await userRepository.findByEmail(userId);
        if (!byEmail) {
          res.status(404).json({ error: 'User not found.' });
          return;
        }
        resolvedId = byEmail.id;
      }

      const MAX_SEED_PREFERENCES = 100;
      const prefs = body.preferences.slice(0, MAX_SEED_PREFERENCES);

      const validPrefs = prefs.filter((pref) => pref.domain && pref.key);
      await Promise.all(
        validPrefs.map((pref) =>
          twinService.updatePreference(resolvedId, {
            id: `pref_seed_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            domain: pref.domain,
            key: pref.key,
            value: pref.value,
            confidence: ConfidenceLevel.HIGH,
            source: 'explicit',
            evidenceIds: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      );

      res.json({ seeded: validPrefs.length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
