import { Router } from 'express';
import { query } from '@skytwin/db';
import { createLogger } from '@skytwin/core';

const log = createLogger('api:about-me');

/**
 * Routes for the self-portrait feature (#190).
 *
 * The self-portrait is an LLM-generated narrative of what the twin has learned
 * about the user, with inline citations to the signals that contributed.
 * LLM integration is stubbed with TODO(#185) until @skytwin/policy-prompts
 * reaches this stack.
 *
 * Endpoints (all under /api/about-me):
 *   GET  /         — return the self-portrait (stub)
 *   POST /correct  — submit a correction for a paragraph/sentence
 */
export function createAboutMeRouter(): Router {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /
  // Returns the self-portrait paragraphs with citation metadata.
  // v1: stubbed — returns a single placeholder paragraph.
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

      // TODO(#185): replace with runPrompt('self-portrait', { user_facts: aggregatedFacts })
      // from @skytwin/policy-prompts, where aggregatedFacts are derived from
      // mempalace knowledge triples + recent decision history for this user.
      // The stub returns a single paragraph directing the user to connect capabilities.
      res.json({
        paragraphs: [
          {
            text: 'Your twin is still gathering signals to build a portrait. Connect Gmail or another capability to begin.',
            citations: [],
          },
        ],
        generatedAt: new Date().toISOString(),
        modelVersion: 'stub-v0',
      });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /correct
  // Body: { paragraphIndex: number, sentenceIndex: number, correction: string }
  // Records a user correction as a provenance feedback node.
  // Hard rail: every correction writes a provenance node before returning.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/correct', async (req, res, next) => {
    try {
      const userId: string | undefined =
        (req as unknown as { user?: { id?: string } }).user?.id ??
        (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as {
        paragraphIndex?: unknown;
        sentenceIndex?: unknown;
        correction?: unknown;
      };

      if (typeof body?.paragraphIndex !== 'number') {
        res.status(400).json({ error: 'paragraphIndex must be a number' });
        return;
      }
      if (typeof body?.sentenceIndex !== 'number') {
        res.status(400).json({ error: 'sentenceIndex must be a number' });
        return;
      }
      if (typeof body?.correction !== 'string' || !body.correction.trim()) {
        res.status(400).json({ error: 'correction must be a non-empty string' });
        return;
      }

      const { paragraphIndex, sentenceIndex, correction } = body as {
        paragraphIndex: number;
        sentenceIndex: number;
        correction: string;
      };

      // Hard rail: write a provenance feedback node for every correction.
      // This ensures no self-portrait mutation happens without an audit trail.
      // The ref_id is the user_id (the portrait is user-scoped, not record-scoped).
      await query(
        `INSERT INTO capability_provenance_nodes
           (user_id, node_type, ref_table, ref_id, server_id, occurred_at, payload)
         VALUES ($1, 'feedback', 'users', $2, NULL, now(), $3)`,
        [
          userId,
          userId,
          JSON.stringify({
            source: 'self_portrait_correction',
            paragraphIndex,
            sentenceIndex,
            correction,
          }),
        ],
      );

      log.info('Self-portrait correction recorded', {
        userId,
        paragraphIndex,
        sentenceIndex,
        correctionLength: correction.length,
      });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
