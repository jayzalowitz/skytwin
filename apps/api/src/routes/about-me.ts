import { Router } from 'express';
import { query } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import { runPrompt } from '@skytwin/policy-prompts';
import { getLlmClientFromConfig } from '../lib/llm-client-factory.js';

const log = createLogger('api:about-me');

/**
 * Routes for the self-portrait feature (#190).
 *
 * J: self-portrait — the GET handler now calls runPrompt('self-portrait', ...)
 * when an LlmClient is available, using aggregated MemPalace-style facts from
 * the capability provenance graph. Falls back to the placeholder paragraph
 * when no LLM is configured or the prompt fails.
 *
 * Endpoints (all under /api/about-me):
 *   GET  /         — return the self-portrait
 *   POST /correct  — submit a correction for a paragraph/sentence
 */

/** Shape of a single paragraph in the self-portrait */
interface SelfPortraitParagraph {
  text: string;
  citations: string[];
}

/** Output shape the self-portrait prompt returns */
interface SelfPortraitOutput {
  paragraphs: SelfPortraitParagraph[];
}

/**
 * Aggregate "user facts" from the provenance graph to provide as context
 * to the self-portrait prompt. These are the signals the twin has collected.
 */
async function aggregateUserFacts(userId: string): Promise<{
  installedCapabilities: Array<{ name: string; trustTier: string }>;
  recentActions: Array<{ nodeType: string; refTable: string; occurredAt: string }>;
  tierPromotions: Array<{ from: string; to: string; at: string }>;
}> {
  try {
    // Installed capabilities
    const capResult = await query<{ display_name: string; trust_tier: string }>(
      `SELECT display_name, trust_tier
       FROM mcp_servers
       WHERE user_id = $1 AND status IN ('active', 'installed', 'authorized')
       LIMIT 20`,
      [userId],
    );

    // Recent provenance actions
    const actionResult = await query<{ node_type: string; ref_table: string; occurred_at: Date }>(
      `SELECT node_type, ref_table, occurred_at
       FROM capability_provenance_nodes
       WHERE user_id = $1
       ORDER BY occurred_at DESC
       LIMIT 30`,
      [userId],
    );

    // Tier promotions
    const promotionResult = await query<{ payload: unknown; occurred_at: Date }>(
      `SELECT payload, occurred_at
       FROM capability_provenance_nodes
       WHERE user_id = $1 AND node_type = 'tier_promotion'
       ORDER BY occurred_at DESC
       LIMIT 10`,
      [userId],
    );

    return {
      installedCapabilities: capResult.rows.map((r) => ({
        name: r.display_name,
        trustTier: r.trust_tier,
      })),
      recentActions: actionResult.rows.map((r) => ({
        nodeType: r.node_type,
        refTable: r.ref_table,
        occurredAt: new Date(r.occurred_at).toISOString(),
      })),
      tierPromotions: promotionResult.rows.map((r) => {
        const p = r.payload as Record<string, unknown> | null;
        return {
          from: String(p?.['from'] ?? ''),
          to: String(p?.['to'] ?? ''),
          at: new Date(r.occurred_at).toISOString(),
        };
      }),
    };
  } catch {
    return { installedCapabilities: [], recentActions: [], tierPromotions: [] };
  }
}

/** Deterministic fallback paragraph */
const PLACEHOLDER_PARAGRAPH: SelfPortraitParagraph = {
  text: 'Your twin is still gathering signals to build a portrait. Connect Gmail or another capability to begin.',
  citations: [],
};

export function createAboutMeRouter(): Router {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /
  // Returns the self-portrait paragraphs with citation metadata.
  //
  // Adaptive path (J: self-portrait): uses the self-portrait prompt with
  // aggregated user facts from the capability provenance graph.
  // Deterministic fallback: single placeholder paragraph.
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

      const llmClient = getLlmClientFromConfig();
      if (llmClient) {
        try {
          const userFacts = await aggregateUserFacts(userId);

          // Only call the LLM if we have meaningful facts to portrait
          const hasFacts =
            userFacts.installedCapabilities.length > 0 ||
            userFacts.recentActions.length > 0;

          if (hasFacts) {
            const result = await runPrompt<SelfPortraitOutput>({
              promptName: 'self-portrait',
              inputs: { user_facts: userFacts },
              user: { userId },
              llmClient,
            });

            if (
              !result.fellBackToDeterministic &&
              Array.isArray(result.output?.paragraphs) &&
              result.output.paragraphs.length > 0
            ) {
              return res.json({
                paragraphs: result.output.paragraphs,
                generatedAt: new Date().toISOString(),
                modelVersion: result.modelUsed ?? 'adaptive-v1',
              });
            }
          }
        } catch (err) {
          log.warn('self-portrait prompt failed, using placeholder', {
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Deterministic fallback: placeholder paragraph
      res.json({
        paragraphs: [PLACEHOLDER_PARAGRAPH],
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
