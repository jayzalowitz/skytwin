import { Router } from 'express';
import { PreferenceArchaeologist, TwinService } from '@skytwin/twin-model';
import { TwinRepositoryAdapter, PatternRepositoryAdapter, proposalRepository } from '@skytwin/db';
import type { PreferenceProposalRow } from '@skytwin/db';
import type { ConfidenceLevel } from '@skytwin/shared-types';

/**
 * Create the preference proposals router.
 */
export function createProposalsRouter(): Router {
  const router = Router();
  const twinRepo = new TwinRepositoryAdapter();
  const patternRepo = new PatternRepositoryAdapter();
  const archaeologist = new PreferenceArchaeologist(twinRepo);
  const twinService = new TwinService(twinRepo, patternRepo);

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
   *
   * On accept: updates proposal status to 'accepted' in DB and creates
   * the preference on the user's twin profile.
   * On reject: updates proposal status to 'rejected' in DB.
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

      // Look up the proposal to verify it exists and belongs to this user
      const proposal: PreferenceProposalRow | null = await proposalRepository.getById(id);
      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      if (proposal.user_id !== userId) {
        res.status(403).json({ error: 'Proposal does not belong to this user' });
        return;
      }
      if (proposal.status !== 'pending') {
        res.status(409).json({ error: `Proposal already ${proposal.status}` });
        return;
      }

      // Update proposal status in the database
      const updatedProposal = await proposalRepository.respond(id, body.accepted);

      // If accepted, create the preference on the twin profile
      if (body.accepted) {
        await twinService.updatePreference(userId, {
          id: `pref_from_proposal_${id}`,
          domain: proposal.domain,
          key: proposal.key,
          value: proposal.value,
          confidence: proposal.confidence as ConfidenceLevel,
          source: 'inferred',
          evidenceIds: ((proposal.supporting_evidence ?? []) as Array<{ evidenceId: string }>).map(
            (e) => e.evidenceId,
          ),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      res.json({
        proposalId: id,
        userId,
        status: updatedProposal.status,
        respondedAt: updatedProposal.responded_at?.toISOString() ?? new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
