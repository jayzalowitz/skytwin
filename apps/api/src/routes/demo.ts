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

/** Operator kill switch — set DEMO_PREVIEW_DISABLED=1 to turn off the public LLM route. */
const PREVIEW_DISABLED = (process.env['DEMO_PREVIEW_DISABLED'] ?? '') === '1';

/** Per-IP limits. */
const PREVIEW_LIMIT = 20;
const PREVIEW_WINDOW_MS = 5 * 60 * 1000;

/** Hard global cap so a misconfigured trust-proxy or many-IP attacker can't run up the LLM bill. */
const PREVIEW_GLOBAL_LIMIT_PER_HOUR = parseInt(process.env['DEMO_PREVIEW_GLOBAL_LIMIT_PER_HOUR'] ?? '500', 10);
const PREVIEW_GLOBAL_WINDOW_MS = 60 * 60 * 1000;

const PREVIEW_MAX_INPUT_LEN = 600;

/** Cache the demo user lookup so the hot path doesn't query DB every request. */
let _cachedDemoUser: Awaited<ReturnType<typeof userRepository.findById>> | null = null;
let _cachedDemoUserAt = 0;
const DEMO_USER_CACHE_TTL_MS = 60 * 1000;

async function getDemoUserCached() {
  const now = Date.now();
  if (_cachedDemoUser && (now - _cachedDemoUserAt) < DEMO_USER_CACHE_TTL_MS) {
    return _cachedDemoUser;
  }
  const fresh = await userRepository.findById(DEMO_USER_ID);
  _cachedDemoUser = fresh;
  _cachedDemoUserAt = now;
  return fresh;
}

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
   * minimal — no profile contents, just availability + the user id. Email
   * and name are deliberately excluded so an operator who reuses the
   * DEMO_USER_ID slot for a real account can't accidentally leak PII.
   */
  router.get('/info', async (req, res, next) => {
    try {
      // Tour mode requires the dashboard's protected endpoints to be
      // reachable for the tour user — that only works when the localhost
      // dev auth bypass is active. In any deployment with real auth, the
      // tour link would land on a 401-riddled dashboard. Be honest:
      // report the demo as unavailable unless the bypass would actually
      // let the tour work.
      const ip = req.ip ?? req.socket.remoteAddress ?? '';
      const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      const devBypass = (process.env['SKYTWIN_DEV_AUTH_BYPASS']
        ?? (process.env['NODE_ENV'] === 'development' ? 'true' : 'false')) === 'true';
      if (!isLocalhost || !devBypass) {
        res.json({ available: false });
        return;
      }

      const user = await getDemoUserCached();
      if (!user) {
        res.json({ available: false });
        return;
      }
      res.json({
        available: true,
        userId: user.id,
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

  // Per-IP rate buckets. NOTE: req.ip resolves through Express's trust-proxy
  // setting; deployments fronted by a reverse proxy must call
  // app.set('trust proxy', N) for this to work as a real per-client limit.
  // The global cap below is the backstop for misconfigured deploys.
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
      // map gets too big. Insertion order; not precise LRU, fine for this.
      const toDelete: string[] = [];
      const drop = Math.floor(previewBuckets.size / 4);
      let i = 0;
      for (const k of previewBuckets.keys()) {
        if (i++ >= drop) break;
        toDelete.push(k);
      }
      for (const k of toDelete) previewBuckets.delete(k);
    }
    return { allowed: true, remaining: PREVIEW_LIMIT - arr.length };
  }

  // Global cap — protects against rotated-IP / spoofed-XFF abuse. Total
  // previews allowed across all callers per hour. Tunable via env.
  const globalPreviewTimestamps: number[] = [];
  function checkGlobalRate(): { allowed: boolean; resetMs: number } {
    const now = Date.now();
    const cutoff = now - PREVIEW_GLOBAL_WINDOW_MS;
    while (globalPreviewTimestamps.length > 0 && globalPreviewTimestamps[0]! <= cutoff) {
      globalPreviewTimestamps.shift();
    }
    if (globalPreviewTimestamps.length >= PREVIEW_GLOBAL_LIMIT_PER_HOUR) {
      const oldest = globalPreviewTimestamps[0] ?? now;
      const resetMs = Math.max(0, oldest + PREVIEW_GLOBAL_WINDOW_MS - now);
      return { allowed: false, resetMs };
    }
    globalPreviewTimestamps.push(now);
    return { allowed: true, resetMs: 0 };
  }

  /**
   * POST /api/demo/preview
   *
   * Public, unauthenticated. Runs whatWouldIDo() against the seeded demo
   * user so the very first onboarding screen can demonstrate the twin
   * reasoning out loud before the visitor invests in any setup.
   *
   * Three tiers of protection:
   *  1. Operator kill switch (DEMO_PREVIEW_DISABLED=1) — drops to 503.
   *  2. Per-IP bucket (20/5min) — gentle throttle for honest callers.
   *  3. Global hourly cap (DEMO_PREVIEW_GLOBAL_LIMIT_PER_HOUR, default 500)
   *     — backstop against rotated-IP/spoofed-XFF abuse so the LLM bill
   *     can't run away if the per-IP limit is bypassed.
   *
   * Returns 404 when the seed hasn't run.
   */
  router.post('/preview', async (req, res, next) => {
    try {
      if (PREVIEW_DISABLED) {
        res.status(503).json({ error: 'Demo preview is disabled on this server.' });
        return;
      }

      // Validate input BEFORE consuming the rate-limit bucket so cheap
      // malformed requests can't burn through a legitimate caller's budget.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const situation = body['situation'];
      if (typeof situation !== 'string' || !situation.trim()) {
        res.status(400).json({ error: 'Missing required field: situation' });
        return;
      }
      if (situation.length > PREVIEW_MAX_INPUT_LEN) {
        res.status(400).json({
          error: `Situation is too long — keep it under ${PREVIEW_MAX_INPUT_LEN} characters.`,
        });
        return;
      }

      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const limit = checkPreviewRate(ip);
      if (!limit.allowed) {
        const retryAfterSec = Math.ceil(PREVIEW_WINDOW_MS / 1000);
        res.set('Retry-After', String(retryAfterSec));
        res.status(429).json({
          error: 'Too many preview requests. Sign in for unlimited use.',
          resetAt: new Date(Date.now() + PREVIEW_WINDOW_MS).toISOString(),
        });
        return;
      }

      const globalLimit = checkGlobalRate();
      if (!globalLimit.allowed) {
        const retryAfterSec = Math.ceil(globalLimit.resetMs / 1000);
        res.set('Retry-After', String(retryAfterSec));
        res.status(429).json({
          error: 'Demo preview is busy right now. Sign in for unlimited use.',
          resetAt: new Date(Date.now() + globalLimit.resetMs).toISOString(),
        });
        return;
      }

      const user = await getDemoUserCached();
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
