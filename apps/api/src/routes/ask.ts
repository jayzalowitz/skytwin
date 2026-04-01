import { Router } from 'express';
import type { WhatWouldIDoRequest, WhatWouldIDoResponse, TwinProfile, Preference } from '@skytwin/shared-types';
import { TrustTier } from '@skytwin/shared-types';
import { DecisionMaker } from '@skytwin/decision-engine';
import type { DecisionRepositoryPort } from '@skytwin/decision-engine';

// ── Rate limit configuration by trust tier ────────────────────────

const RATE_LIMITS: Record<TrustTier, number> = {
  [TrustTier.OBSERVER]: 60,
  [TrustTier.SUGGEST]: 120,
  [TrustTier.LOW_AUTONOMY]: 240,
  [TrustTier.MODERATE_AUTONOMY]: 360,
  [TrustTier.HIGH_AUTONOMY]: 600,
};

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function checkRateLimit(userId: string, trustTier: TrustTier): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const limit = RATE_LIMITS[trustTier];
  const oneHourMs = 60 * 60 * 1000;

  let entry = rateLimitMap.get(userId);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + oneHourMs };
    rateLimitMap.set(userId, entry);
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count, resetAt: entry.resetAt };
}

// ── Mock dependencies for scaffold ───────────────────────────────

function createMockDecisionRepository(): DecisionRepositoryPort {
  return {
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
}

function createMockTwinService() {
  const defaultProfile: TwinProfile = {
    id: 'twin_mock',
    userId: 'mock',
    version: 1,
    preferences: [],
    inferences: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    getOrCreateProfile: async (_userId: string): Promise<TwinProfile> => defaultProfile,
    getRelevantPreferences: async (_userId: string, _domain: string, _situation: string): Promise<Preference[]> => [],
    getPatterns: async (_userId: string): Promise<unknown[]> => [],
    getTraits: async (_userId: string): Promise<unknown[]> => [],
    getTemporalProfile: async (_userId: string): Promise<unknown> => ({
      userId: _userId,
      activeHours: { start: 8, end: 22 },
      peakResponseTimes: {},
      weekdayPatterns: {},
      urgencyThresholds: {},
    }),
  };
}

function createMockPolicyEvaluator() {
  return {
    evaluate: async () => ({
      allowed: true,
      requiresApproval: false,
      reason: 'Mock policy check passed.',
    }),
    loadPolicies: async () => [],
    checkSpendLimit: () => true,
    checkReversibility: () => true,
    checkDomainAllowlist: () => true,
  };
}

// ── Router ───────────────────────────────────────────────────────

/**
 * Create the ask (whatWouldIDo) router.
 *
 * POST /ask/:userId -- predict what the twin would do in a hypothetical
 * situation without persisting any state.
 */
export function createAskRouter(): Router {
  const router = Router();

  router.post('/ask/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const body = req.body as Record<string, unknown>;

      if (!body['situation'] || typeof body['situation'] !== 'string') {
        res.status(400).json({ error: 'Missing required field: situation (string)' });
        return;
      }

      // Determine user trust tier (scaffold: default to SUGGEST)
      const userTrustTier = (body['trustTier'] as TrustTier) ?? TrustTier.SUGGEST;

      // Rate limit check
      const rateLimitResult = checkRateLimit(userId, userTrustTier);
      if (!rateLimitResult.allowed) {
        res.status(429).json({
          error: 'Rate limit exceeded',
          resetAt: new Date(rateLimitResult.resetAt).toISOString(),
          remaining: 0,
        });
        return;
      }

      const request: WhatWouldIDoRequest = {
        situation: body['situation'] as string,
        domain: typeof body['domain'] === 'string' ? body['domain'] : undefined,
        urgency: typeof body['urgency'] === 'string'
          ? (body['urgency'] as WhatWouldIDoRequest['urgency'])
          : undefined,
      };

      // Create mock dependencies (scaffold -- replace with real DI later)
      const mockDecisionRepo = createMockDecisionRepository();
      const mockTwinService = createMockTwinService();
      const mockPolicyEvaluator = createMockPolicyEvaluator();

      const decisionMaker = new DecisionMaker(
        mockTwinService as never,
        mockPolicyEvaluator as never,
        mockDecisionRepo as never,
      );

      const response: WhatWouldIDoResponse = await decisionMaker.whatWouldIDo(
        userId,
        request,
        mockTwinService,
        userTrustTier,
      );

      res.json({
        ...response,
        rateLimit: {
          remaining: rateLimitResult.remaining,
          resetAt: new Date(rateLimitResult.resetAt).toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
