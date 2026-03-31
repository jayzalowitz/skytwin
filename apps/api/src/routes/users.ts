import { Router } from 'express';
import { userRepository } from '@skytwin/db';

/**
 * Create the users management router.
 */
export function createUsersRouter(): Router {
  const router = Router();

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

      const user = await userRepository.findById(userId);
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

      const validTiers = ['observer', 'suggest', 'low_autonomy', 'moderate_autonomy', 'high_autonomy'];
      if (!validTiers.includes(body.trustTier)) {
        res.status(400).json({
          error: `Invalid trust tier. Must be one of: ${validTiers.join(', ')}`,
        });
        return;
      }

      const updated = await userRepository.updateTrustTier(userId, body.trustTier);
      res.json({ user: updated });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
