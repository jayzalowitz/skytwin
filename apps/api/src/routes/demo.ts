import { Router } from 'express';
import {
  userRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  policyRepositoryAdapter,
} from '@skytwin/db';
import type {
  WhatWouldIDoRequest,
  WhatWouldIDoResponse,
  DemoInfoResponse,
  DemoSessionResponse,
  DemoPreviewResponse,
} from '@skytwin/shared-types';
import { TrustTier, DEMO_RECIPES } from '@skytwin/shared-types';
import { DecisionMaker } from '@skytwin/decision-engine';
import type { DecisionRepositoryPort } from '@skytwin/decision-engine';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import {
  DEMO_USER_ID,
  isLocalDemoRequest,
  issueDemoSession,
} from '../auth/demo-session.js';

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
/** Operator kill switch — set DEMO_PREVIEW_DISABLED=1 to turn off the public LLM route.
 *  Read at request time so an operator can flip the kill switch without restarting. */
function isPreviewDisabled(): boolean {
  return (process.env['DEMO_PREVIEW_DISABLED'] ?? '') === '1';
}

/** Per-IP limits. */
const PREVIEW_LIMIT = 20;
const PREVIEW_WINDOW_MS = 5 * 60 * 1000;

/** Hard global cap so a misconfigured trust-proxy or many-IP attacker can't run up the LLM bill.
 *  Validated at module load: a malformed env value falls back to the default rather than
 *  silently disabling the cap (NaN compares always-false). Negative or zero is also rejected. */
const PREVIEW_GLOBAL_LIMIT_PER_HOUR = (() => {
  const raw = process.env['DEMO_PREVIEW_GLOBAL_LIMIT_PER_HOUR'];
  if (raw == null || raw === '') return 500;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[demo] DEMO_PREVIEW_GLOBAL_LIMIT_PER_HOUR=${raw} is invalid; falling back to 500.`,
    );
    return 500;
  }
  return parsed;
})();
const PREVIEW_GLOBAL_WINDOW_MS = 60 * 60 * 1000;

const PREVIEW_MAX_INPUT_LEN = 600;

/** The packaged tour should not mint unlimited credentials from one process. */
const SAMPLE_SESSION_LIMIT = 12;
const SAMPLE_SESSION_WINDOW_MS = 5 * 60 * 1000;

/** Cache the demo user lookup so the hot path doesn't query DB every request. */
let _cachedDemoUser: Awaited<
  ReturnType<typeof userRepository.findDemoById>
> | null = null;
let _cachedDemoUserAt = 0;
const DEMO_USER_CACHE_TTL_MS = 60 * 1000;

async function getDemoUserCached() {
  const now = Date.now();
  if (_cachedDemoUser && now - _cachedDemoUserAt < DEMO_USER_CACHE_TTL_MS) {
    return _cachedDemoUser;
  }
  const fresh = await userRepository.findDemoById(DEMO_USER_ID);
  _cachedDemoUser = fresh;
  _cachedDemoUserAt = now;
  return fresh;
}

/**
 * Test-only: drop the cached demo user so each test starts fresh. Not
 * exported to consumers (the route doesn't need a public invalidation
 * hook today — the 60s TTL handles staleness in production).
 */
export function _resetDemoCacheForTests(): void {
  _cachedDemoUser = null;
  _cachedDemoUserAt = 0;
}

/**
 * Public router for the in-app tour.
 *
 * Lets a brand-new visitor land on a populated dashboard (Alex Thompson's
 * seeded twin) before they invest in the Google Cloud OAuth credential
 * setup. The short-lived sample session is a separate, read-only principal;
 * production authentication and normal user sessions remain unchanged.
 */
export function createDemoRouter(): Router {
  const router = Router();
  const sampleSessionBuckets = new Map<string, number[]>();

  function checkSampleSessionRate(ip: string): {
    allowed: boolean;
    retryAfterMs: number;
  } {
    const now = Date.now();
    const cutoff = now - SAMPLE_SESSION_WINDOW_MS;
    for (const [key, values] of sampleSessionBuckets) {
      if (values.every((timestamp) => timestamp <= cutoff)) {
        sampleSessionBuckets.delete(key);
      }
    }
    const timestamps = (sampleSessionBuckets.get(ip) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (timestamps.length >= SAMPLE_SESSION_LIMIT) {
      sampleSessionBuckets.set(ip, timestamps);
      return {
        allowed: false,
        retryAfterMs: Math.max(
          0,
          timestamps[0]! + SAMPLE_SESSION_WINDOW_MS - now,
        ),
      };
    }
    timestamps.push(now);
    sampleSessionBuckets.set(ip, timestamps);
    return { allowed: true, retryAfterMs: 0 };
  }

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
      const ip = req.ip;
      if (!isLocalDemoRequest(ip, req.socket.remoteAddress)) {
        res.status(403).json({
          error: 'The packaged sample is available from this device only.',
        });
        return;
      }
      const user = await getDemoUserCached();
      if (!user) {
        const unavailable: DemoInfoResponse = { available: false };
        res.json(unavailable);
        return;
      }
      const ok: DemoInfoResponse = { available: true, userId: user.id };
      res.json(ok);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/demo/session
   *
   * Starts an account-free sample session. The returned credential is signed,
   * short-lived, fixed to DEMO_USER_ID, and restricted by sessionAuth to an
   * explicit set of read routes. It cannot mutate sample data or access users.
   */
  router.post('/session', async (req, res, next) => {
    try {
      const ip = req.ip;
      if (!isLocalDemoRequest(ip, req.socket.remoteAddress)) {
        res.status(403).json({
          error: 'The packaged sample is available from this device only.',
        });
        return;
      }
      // Credential issuance is also the readiness revocation boundary. Do not
      // use the informational cache here: provisioning may have just marked a
      // previously complete fixture unavailable for repair.
      const user = await userRepository.findDemoById(DEMO_USER_ID);
      if (!user) {
        res
          .status(404)
          .json({ error: 'Demo profile not available on this server.' });
        return;
      }
      const limit = checkSampleSessionRate(ip ?? 'unknown');
      if (!limit.allowed) {
        res.set(
          'Retry-After',
          String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))),
        );
        res.status(429).json({
          error: 'Too many sample sessions. Reuse or reset the current sample.',
        });
        return;
      }
      const presented = req.headers.authorization;
      const replacedToken = presented?.startsWith('Bearer ')
        ? presented.slice(7)
        : undefined;
      // Browser renewal presents the credential it is replacing. Retire that
      // exact authority before minting the successor so delayed requests from
      // the previous session cannot recreate disposable state.
      const session = issueDemoSession(Date.now(), replacedToken);
      const response: DemoSessionResponse = {
        token: session.token,
        userId: DEMO_USER_ID,
        expiresAt: session.expiresAt.toISOString(),
      };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/demo/recipes
   *
   * Public, unauthenticated, no rate limit — returns the canned demo recipe
   * library (#405). These are static, fictional sample situations the tour
   * UI offers so a visitor can see the twin reason across SkyTwin's headline
   * workflows (newsletter triage, calendar-conflict resolution, subscription
   * renewal, meeting prep, expense categorization, recurring-task handling).
   *
   * No LLM cost, no DB read, no user data — just the frozen catalog from
   * shared-types — so it doesn't need the preview route's rate-limit guards.
   * Each recipe's `situation` is what the dashboard's "Try this on your real
   * data" button submits to the (guarded) prediction path.
   */
  router.get('/recipes', (_req, res) => {
    res.json({ recipes: DEMO_RECIPES });
  });

  // Read-only prediction infra. Same shape as the protected /v1/twin/ask
  // route, but bound to the demo user so an unauthenticated visitor on
  // step 1 of onboarding can feel the twin reason before signing in.
  // No-op decision repo so previews don't pollute the demo user's history.
  const noOpRepo: DecisionRepositoryPort = {
    saveDecision: async (d) => ({ decision: d, created: true }),
    getDecision: async () => null,
    saveOutcome: async (o) => o,
    getOutcome: async () => null,
    saveCandidates: async (c) => c,
    getCandidates: async () => [],
    saveRiskAssessment: async (a) => a,
    getRiskAssessment: async () => null,
    getRecentDecisions: async () => [],
  };
  const twinService = new TwinService(
    new TwinRepositoryAdapter(),
    new PatternRepositoryAdapter(),
  );
  const policyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);
  const decisionMaker = new DecisionMaker(
    twinService,
    policyEvaluator,
    noOpRepo,
  );

  // Per-IP rate buckets. NOTE: req.ip resolves through Express's trust-proxy
  // setting; deployments fronted by a reverse proxy must call
  // app.set('trust proxy', N) for this to work as a real per-client limit.
  // The global cap below is the backstop for misconfigured deploys.
  const previewBuckets = new Map<string, number[]>();
  function checkPreviewRate(ip: string): {
    allowed: boolean;
    remaining: number;
  } {
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
    while (
      globalPreviewTimestamps.length > 0 &&
      globalPreviewTimestamps[0]! <= cutoff
    ) {
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
      if (isPreviewDisabled()) {
        res
          .status(503)
          .json({ error: 'Demo preview is disabled on this server.' });
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

      // Resolve the demo user BEFORE consuming any rate-limit budget.
      // If the seed isn't on this server, every preview returns 404 —
      // burning per-IP and global capacity on those failures would lock
      // legitimate callers out of an already-broken endpoint for no
      // reason. Cheap because the demo user is memoized.
      const user = await getDemoUserCached();
      if (!user) {
        res
          .status(404)
          .json({ error: 'Demo profile not available on this server.' });
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

      const previewResponse: DemoPreviewResponse = {
        ...response,
        previewRateLimit: {
          remaining: limit.remaining,
          windowMs: PREVIEW_WINDOW_MS,
        },
      };
      res.json(previewResponse);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
