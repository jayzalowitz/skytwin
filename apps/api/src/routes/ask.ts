import { Router } from 'express';
import type { WhatWouldIDoRequest, WhatWouldIDoResponse } from '@skytwin/shared-types';
import { TrustTier } from '@skytwin/shared-types';
import { DecisionMaker } from '@skytwin/decision-engine';
import type { DecisionRepositoryPort } from '@skytwin/decision-engine';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import {
  twinRepository,
  patternRepository,
  policyRepositoryAdapter,
} from '@skytwin/db';

/**
 * No-op decision repository for the prediction endpoint.
 *
 * whatWouldIDo() internally calls evaluate() which persists decisions,
 * candidates, outcomes, and risk assessments. For read-only predictions
 * we use this no-op repo to prevent polluting real decision history
 * with synthetic query_* records.
 */
function createNoOpDecisionRepository(): DecisionRepositoryPort {
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

// ── Rate limit configuration by trust tier ────────────────────────

export const RATE_LIMITS: Record<TrustTier, number> = {
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

export function checkRateLimit(userId: string, trustTier: TrustTier): { allowed: boolean; remaining: number; resetAt: number } {
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

// ── Router ───────────────────────────────────────────────────────

/**
 * Create the ask (whatWouldIDo) router.
 *
 * POST /ask/:userId -- predict what the twin would do in a hypothetical
 * situation without persisting any state.
 */
export function createAskRouter(): Router {
  const router = Router();

  // Real TwinService + PolicyEvaluator for accurate reads.
  // No-op DecisionRepository because whatWouldIDo() is read-only:
  // it must not persist synthetic query_* decisions to the DB.
  const twinService = new TwinService(twinRepository as never, patternRepository as never);
  const policyEvaluator = new PolicyEvaluator(policyRepositoryAdapter as never);
  const noOpDecisionRepo = createNoOpDecisionRepository();
  const decisionMaker = new DecisionMaker(
    twinService as never,
    policyEvaluator as never,
    noOpDecisionRepo,
  );

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

      // Trust tier is server-determined, not client-supplied.
      // TODO: Look up user's earned trust tier from the users table.
      // New users default to OBSERVER (Safety Invariant #3).
      const userTrustTier = TrustTier.OBSERVER;

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

      const response: WhatWouldIDoResponse = await decisionMaker.whatWouldIDo(
        userId,
        request,
        twinService,
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
