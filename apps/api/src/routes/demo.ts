import { Router } from 'express';
import {
  userRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  policyRepositoryAdapter,
} from '@skytwin/db';
import type { WhatWouldIDoRequest, WhatWouldIDoResponse } from '@skytwin/shared-types';
import { TrustTier } from '@skytwin/shared-types';
import { DecisionMaker } from '@skytwin/decision-engine';
import type { DecisionRepositoryPort } from '@skytwin/decision-engine';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';

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

  // Read-only prediction infra. Same shape as the protected /v1/twin/ask
  // route, but bound to the demo user so an unauthenticated visitor on
  // step 1 of onboarding can feel the twin reason before signing in.
  // No-op decision repo so previews don't pollute the demo user's history.
  const noOpRepo: DecisionRepositoryPort = {
    saveDecision: async (d) => d,
    getDecision: async () => null,
    saveOutcome: async (o) => o,
    getOutcome: async () => null,
    saveCandidates: async (c) => c,
    getCandidates: async () => [],
    saveRiskAssessment: async (a) => a,
    getRiskAssessment: async () => null,
    getRecentDecisions: async () => [],
  };
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());
  const policyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);
  const decisionMaker = new DecisionMaker(twinService, policyEvaluator, noOpRepo);

  // Lightweight per-IP rate limit so the public preview can't be cheaply
  // turned into a free LLM proxy. 20 requests / 5min per IP, drops
  // expired buckets to bound memory.
  const PREVIEW_LIMIT = 20;
  const PREVIEW_WINDOW_MS = 5 * 60 * 1000;
  const previewBuckets = new Map<string, number[]>();
  function checkPreviewRate(ip: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const cutoff = now - PREVIEW_WINDOW_MS;
    const arr = (previewBuckets.get(ip) ?? []).filter((t) => t > cutoff);
    if (arr.length >= PREVIEW_LIMIT) {
      previewBuckets.set(ip, arr);
      return { allowed: false, remaining: 0 };
    }
    arr.push(now);
    previewBuckets.set(ip, arr);
    if (previewBuckets.size > 1000) {
      // Coarse eviction — drop a quarter of the oldest entries when the
      // map gets too big. We don't need precise LRU here.
      const drop = Math.floor(previewBuckets.size / 4);
      let i = 0;
      for (const k of previewBuckets.keys()) {
        if (i++ >= drop) break;
        previewBuckets.delete(k);
      }
    }
    return { allowed: true, remaining: PREVIEW_LIMIT - arr.length };
  }

  /**
   * POST /api/demo/preview
   *
   * Public, unauthenticated. Runs whatWouldIDo() against the seeded demo
   * user so the very first onboarding screen can demonstrate the twin
   * reasoning out loud before the visitor invests in any setup.
   * Returns 404 when the seed hasn't run.
   */
  router.post('/preview', async (req, res, next) => {
    try {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const limit = checkPreviewRate(ip);
      if (!limit.allowed) {
        res.status(429).json({
          error: 'Too many preview requests. Sign in for unlimited use.',
        });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const situation = body['situation'];
      if (typeof situation !== 'string' || !situation.trim()) {
        res.status(400).json({ error: 'Missing required field: situation' });
        return;
      }
      if (situation.length > 600) {
        res.status(400).json({ error: 'Situation is too long — keep it under 600 characters.' });
        return;
      }

      const user = await userRepository.findById(DEMO_USER_ID);
      if (!user) {
        res.status(404).json({ error: 'Demo profile not available on this server.' });
        return;
      }

      const trustTier = (() => {
        const t = user.trust_tier;
        if (t === 'observer') return TrustTier.OBSERVER;
        if (t === 'suggest') return TrustTier.SUGGEST;
        if (t === 'low_autonomy') return TrustTier.LOW_AUTONOMY;
        if (t === 'moderate_autonomy') return TrustTier.MODERATE_AUTONOMY;
        if (t === 'high_autonomy') return TrustTier.HIGH_AUTONOMY;
        return TrustTier.OBSERVER;
      })();

      const request: WhatWouldIDoRequest = {
        situation,
        domain: typeof body['domain'] === 'string' ? body['domain'] : undefined,
      };

      const response: WhatWouldIDoResponse = await decisionMaker.whatWouldIDo(
        DEMO_USER_ID,
        request,
        twinService,
        trustTier,
      );

      res.json({
        ...response,
        previewRateLimit: { remaining: limit.remaining, windowMs: PREVIEW_WINDOW_MS },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
