import { Router } from 'express';
import { riskProfileRepository } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import { runPrompt } from '@skytwin/policy-prompts';
import { getLlmClientFromConfig } from '../lib/llm-client-factory.js';

const log = createLogger('api:risk-profile');

/**
 * Routes for the user risk profile (#190).
 *
 * The risk profile is a free-form English description of the user's autonomy
 * preferences. It is interpreted by the risk-profile-interpretation prompt
 * into structured `interpreted_caps` that narrow the effective AutonomySettings
 * on the hot path.
 *
 * I: risk-profile-interpretation — the PUT handler and POST /reinterpret now
 * call runPrompt('risk-profile-interpretation', ...) when an LlmClient is
 * available. Falls back to {} when no LLM is configured or the prompt fails.
 *
 * Endpoints (all under /api/risk-profile):
 *   GET  /           — return profile text + interpreted_caps for requesting user
 *   PUT  /           — upsert profile text, trigger interpretation
 *   POST /reinterpret — manual trigger for LLM re-interpretation
 */

/** Shape the risk-profile-interpretation prompt returns */
interface RiskProfileInterpretationOutput {
  spend_limit_per_action_cents?: number;
  daily_spend_limit_cents?: number;
  auto_approve_domains?: string[];
  escalate_domains?: string[];
  boldness?: 'conservative' | 'moderate' | 'bold';
  raw_notes?: string;
}

/**
 * Run the risk-profile-interpretation prompt and return structured caps,
 * or {} on any failure.
 */
async function interpretProfileText(
  userId: string,
  profileText: string,
): Promise<Record<string, unknown>> {
  const llmClient = getLlmClientFromConfig();
  if (!llmClient || !profileText.trim()) return {};

  try {
    // Template expects {{risk_profile_text}}, not {{profileText}}.
    const result = await runPrompt<RiskProfileInterpretationOutput>({
      promptName: 'risk-profile-interpretation',
      inputs: { risk_profile_text: profileText },
      user: { userId },
      llmClient,
    });

    if (result.fellBackToDeterministic) return {};

    // Return the output cast to Record<string, unknown> for storage
    return (result.output as Record<string, unknown>) ?? {};
  } catch (err) {
    log.warn('risk-profile-interpretation prompt failed, using empty caps', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

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
  // Upserts the profile text, then runs interpretation (adaptive if LLM
  // available, {} fallback otherwise).
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

      // Step 2: I: risk-profile-interpretation — adaptive path with {} fallback.
      const interpretedCaps = await interpretProfileText(userId, profileText);
      const modelVersion = getLlmClientFromConfig() ? 'adaptive-v1' : 'stub-v0';

      const updatedRow = await riskProfileRepository.updateInterpretedCaps({
        userId,
        interpretedCaps,
        modelVersion,
      });

      if (!updatedRow) {
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
  // Adaptive: re-interprets the stored profile text and updates interpretedCaps.
  // Deterministic fallback: stores {} and returns status='no_llm'.
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

      const row = await riskProfileRepository.getForUser(userId);
      const profileText = row?.profile_text ?? '';

      if (!profileText.trim()) {
        res.json({
          status: 'no_profile',
          message: 'No profile text saved yet. Use PUT / to save a profile first.',
        });
        return;
      }

      const interpretedCaps = await interpretProfileText(userId, profileText);
      const llmClient = getLlmClientFromConfig();
      const modelVersion = llmClient ? 'adaptive-v1' : 'stub-v0';

      await riskProfileRepository.updateInterpretedCaps({
        userId,
        interpretedCaps,
        modelVersion,
      });

      log.info('Risk profile reinterpreted', { userId, hasLlm: llmClient !== null });
      res.json({
        status: llmClient ? 'ok' : 'no_llm',
        interpretedCaps,
        message: llmClient
          ? 'Profile re-interpreted successfully.'
          : 'No LLM provider configured. Stored empty caps.',
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
