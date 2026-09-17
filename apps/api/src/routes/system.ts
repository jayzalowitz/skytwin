/**
 * Public system router — a minimized local-model recommendation for onboarding.
 * Raw host hardware remains server-internal.
 */

import { Router } from 'express';
import { recommendLocalModel } from '../system/hardware.js';

export function createSystemRouter(): Router {
  const router = Router();

  // GET /api/system/recommend-local-model — the single best local model that
  // actually fits this machine (RAM + free disk), with a human explanation.
  // This is what lets onboarding say "we'll use X for your computer" instead of
  // making a non-technical user choose from a list.
  router.get('/recommend-local-model', (_req, res) => {
    const recommendation = recommendLocalModel();
    res.json({
      model: recommendation.model,
      reason: recommendation.model
        ? `Recommended local model: ${recommendation.model.displayName} (~${recommendation.downloadGB ?? "?"} GB). A compatible llama.cpp runtime is also required.`
        : "No maintained local model fits the available resources on this computer.",
      fitsDisk: recommendation.fitsDisk,
      downloadGB: recommendation.downloadGB,
    });
  });

  return router;
}
