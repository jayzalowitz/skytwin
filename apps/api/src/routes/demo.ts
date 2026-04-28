import { Router } from 'express';
import { userRepository } from '@skytwin/db';

/**
 * UUID of the seeded "Alex Thompson" demo user from
 * packages/db/src/seeds/seed.ts. The seed runs as part of bin/skytwin-install
 * (and `pnpm db:seed`), so this user exists on any machine that ran the
 * one-command installer.
 *
 * Hardcoding is intentional: the demo user is a stable, well-known fixture
 * with a populated twin profile, decision history, learnings, and
 * approvals — that's what makes the "take a tour" button worth offering.
 */
const DEMO_USER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/**
 * Public router for the in-app tour.
 *
 * Lets a brand-new visitor land on a populated dashboard (Alex Thompson's
 * seeded twin) before they invest in the Google Cloud OAuth credential
 * setup. Only exposes read-style discovery; switching to the user goes
 * through the existing user-switcher path so all the dev-bypass auth
 * rules still apply.
 */
export function createDemoRouter(): Router {
  const router = Router();

  /**
   * GET /api/demo/info
   *
   * Reports whether the seeded demo user is present so the onboarding flow
   * can decide whether to offer the tour link. Response is intentionally
   * minimal — no profile contents, just availability + the user id.
   */
  router.get('/info', async (_req, res, next) => {
    try {
      const user = await userRepository.findById(DEMO_USER_ID);
      if (!user) {
        res.json({ available: false });
        return;
      }
      res.json({
        available: true,
        userId: user.id,
        name: user.name,
        email: user.email,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
