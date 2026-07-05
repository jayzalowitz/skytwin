/**
 * Public system router — hardware detection + hardware-aware local-model
 * recommendation. Mounted WITHOUT auth (like /api/v1/demo) because onboarding
 * asks "what's the best local AI for this computer?" before the user has signed
 * in. Returns only coarse, non-sensitive machine facts (RAM/disk/cores/arch)
 * and a model pick from the public catalog.
 */

import { Router } from 'express';
import { detectHardware, recommendLocalModel } from '../system/hardware.js';

export function createSystemRouter(): Router {
  const router = Router();

  // GET /api/system/hardware — coarse machine profile for sizing decisions.
  router.get('/hardware', (_req, res) => {
    res.json(detectHardware());
  });

  // GET /api/system/recommend-local-model — the single best local model that
  // actually fits this machine (RAM + free disk), with a human explanation.
  // This is what lets onboarding say "we'll use X for your computer" instead of
  // making a non-technical user choose from a list.
  router.get('/recommend-local-model', (_req, res) => {
    res.json(recommendLocalModel());
  });

  return router;
}
