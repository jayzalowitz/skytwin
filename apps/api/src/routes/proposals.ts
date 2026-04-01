import { Router } from 'express';
import { PreferenceArchaeologist } from '@skytwin/twin-model';
import { twinRepository } from '@skytwin/db';

/**
 * Create the preference proposals router.
 */
export function createProposalsRouter(): Router {
  const router = Router();
  const archaeologist = new PreferenceArchaeologist(twinRepository as never);

  /**
   * GET /api/proposals/:userId
   *
   * List pending preference proposals for a user.
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const proposals = await archaeologist.analyze(userId);

      res.json({
        userId,
        proposals: proposals.filter((p) => p.status === 'pending'),
        total: proposals.length,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/proposals/:userId/:id
   *
   * Accept or reject a preference proposal.
   * Body: { accepted: boolean }
   */
  router.post('/:userId/:id', async (req, res, next) => {
    try {
      const { userId, id } = req.params;
      if (!userId || !id) {
        res.status(400).json({ error: 'Missing userId or proposal id parameter' });
        return;
      }

      const body = req.body as { accepted?: boolean };
      if (typeof body.accepted !== 'boolean') {
        res.status(400).json({ error: 'Missing required field: accepted (boolean)' });
        return;
      }

      // In a full implementation, we would look up the proposal by id,
      // update its status, and if accepted, create the preference.
      // For now, we scaffold the response.
      const status = body.accepted ? 'accepted' : 'rejected';

      res.json({
        proposalId: id,
        userId,
        status,
        respondedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
