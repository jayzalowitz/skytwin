import { Router } from 'express';
import { riskProfileRepository } from '@skytwin/db';
import { createLogger } from '@skytwin/core';

const log = createLogger('api:risk-profile');

/**
 * Routes for the user risk profile (#190).
 *
 * The risk profile is a free-form English description of the user's autonomy
 * preferences. It is interpreted by an LLM into structured `interpreted_caps`
 * that narrow the effective AutonomySettings on the hot path. LLM integration
 * is stubbed with TODO(#185) until @skytwin/policy-prompts reaches this stack.
 *
 * Endpoints (all under /api/risk-profile):
 *   GET  /           — return profile text + interpreted_caps for requesting user
 *   PUT  /           — upsert profile text, trigger stub interpretation
 *   POST /reinterpret — manual trigger for LLM re-interpretation (stubbed)
 */
export function createRiskProfileRouter(): Router {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /
  // Returns { profileText, interpretedCaps, lastInterpretedAt, lastModelVersion }
  // for the requesting user. If no row exists, returns defaults.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/', async (req, res, next) => {
    try {
      const userId: string | undefined =
        (req as unknown as { user?: { id?: string } }).user?.id ??
        (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const row = await riskProfileRepository.getForUser(userId);
      if (!row) {
        res.json({
          profileText: '',
          interpretedCaps: {},
          lastInterpretedAt: null,
          lastModelVersion: null,
        });
        return;
      }

      res.json({
        profileText: row.profile_text,
        interpretedCaps: row.interpreted_caps,
        lastInterpretedAt: row.last_interpreted_at?.toISOString() ?? null,
        lastModelVersion: row.last_model_version,
      });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /
  // Body: { profileText: string }
  // Upserts the profile text then runs a stub interpretation.
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/', async (req, res, next) => {
    try {
      const userId: string | undefined =
        (req as unknown as { user?: { id?: string } }).user?.id ??
        (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as { profileText?: unknown };
      if (typeof body?.profileText !== 'string') {
        res.status(400).json({ error: 'profileText must be a string' });
        return;
      }

      const profileText = body.profileText;

      // Step 1: Upsert the profile text row.
      await riskProfileRepository.upsert({ userId, profileText });

      // Step 2: Stub interpretation.
      // TODO(#185): replace with runPrompt('risk-profile-interpretation', { text: profileText })
      // from @skytwin/policy-prompts once that package reaches this stack.
      // For v1, just store an empty interpretedCaps so SpendTracker falls back
      // to user-global AutonomySettings caps. The stub keeps the API contract
      // stable and makes the field non-null for downstream consumers.
      const interpretedCaps = {};
      const updatedRow = await riskProfileRepository.updateInterpretedCaps({
        userId,
        interpretedCaps,
        modelVersion: 'stub-v0',
      });

      if (!updatedRow) {
        // Should never happen — we just upserted above
        res.status(500).json({ error: 'Failed to update interpreted caps' });
        return;
      }

      log.info('Risk profile upserted', { userId, profileLength: profileText.length });

      res.json({
        profileText: updatedRow.profile_text,
        interpretedCaps: updatedRow.interpreted_caps,
        lastInterpretedAt: updatedRow.last_interpreted_at?.toISOString() ?? null,
        lastModelVersion: updatedRow.last_model_version,
      });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /reinterpret
  // Manual trigger for re-running LLM interpretation.
  // v1: stubbed — returns status='stubbed'.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/reinterpret', async (req, res, next) => {
    try {
      const userId: string | undefined =
        (req as unknown as { user?: { id?: string } }).user?.id ??
        (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // TODO(#185): replace with runPrompt('risk-profile-interpretation', { text: profileText })
      // from @skytwin/policy-prompts. This endpoint exists so the frontend can
      // manually trigger re-interpretation after a profile edit; the real implementation
      // will enqueue a background job and return a jobId.
      log.info('Risk profile reinterpret requested (stubbed)', { userId });
      res.json({
        status: 'stubbed',
        message: 'LLM interpretation lands when #185 reaches this stack',
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
