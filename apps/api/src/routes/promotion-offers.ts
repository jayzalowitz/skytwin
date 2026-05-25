/**
 * Promotion-offer routes (#310).
 *
 * GET  /promotion-offers/:userId      — list pending offers for polling
 * POST /promotion-offers/:offerId/respond — accept/reject/dismiss an offer
 *
 * The promotion ceremony used to fire directly from the worker via
 * SSE, but the worker has no in-process sseManager. #310's worker→API
 * bridge replaced the SSE-emit with a write to `promotion_offers`.
 * This router serves that durable surface to the dashboard.
 *
 * Acceptance on the server compares the stored snapshot tier
 * against the live mcp_servers row — a user clicking Accept on a
 * stale offer (admin demoted the server in between) is refused and
 * the offer is marked responded with `response='rejected'` to clean
 * up state.
 */
import { Router } from 'express';
import { createLogger } from '@skytwin/core';
import {
  promotionOffersRepository,
  type PromotionOfferRow,
  type PromotionOfferResponse,
} from '@skytwin/db';
import type { TrustTier } from '@skytwin/shared-types';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';
import { sseManager, SSE_CAPABILITY_PROMOTION_OFFERED } from '../sse.js';

const log = createLogger('api:promotion-offers');

const VALID_RESPONSES: ReadonlySet<PromotionOfferResponse> = new Set([
  'accepted',
  'rejected',
  'dismissed',
]);

interface PromotionOfferDTO {
  id: string;
  serverId: string;
  serverName: string | null;
  currentTier: TrustTier;
  proposedTier: TrustTier;
  reason: string;
  decisionsObservedCount: number;
  approvedCount: number;
  offeredAt: string;
}

function rowToDTO(
  row: PromotionOfferRow & { server_name?: string | null },
): PromotionOfferDTO {
  return {
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name ?? null,
    currentTier: row.current_tier as TrustTier,
    proposedTier: row.proposed_tier as TrustTier,
    reason: row.reason,
    decisionsObservedCount: row.decisions_observed_count,
    approvedCount: row.approved_count,
    offeredAt: row.offered_at.toISOString(),
  };
}

export function createPromotionOffersRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);

  /**
   * GET /promotion-offers/:userId
   *
   * Returns all pending offers for the user, newest first. The
   * dashboard hits this on connect AND on a polling interval. Live
   * connections may also receive a `capability:promotion-offered`
   * SSE event when an offer first lands — but this endpoint is the
   * source of truth (survives API restart, lets a fresh tab catch
   * up on offers that were emitted while the tab was closed).
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }
      const rows = await promotionOffersRepository.listPendingWithServerName(userId);
      res.json({ offers: rows.map(rowToDTO) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /promotion-offers/:offerId/respond
   *
   * Body: { userId: string; response: 'accepted' | 'rejected' | 'dismissed' }
   *
   * On accept: bump `mcp_servers.trust_tier` to the offer's
   * proposed_tier — but only if the server is still at the
   * snapshot's current_tier (no stale-acceptance after an admin
   * demotion). On all responses: mark the offer responded with the
   * given response value.
   *
   * The userId in the body is cross-checked against the offer's
   * user_id and against the session — preventing a user from
   * responding to another user's offer.
   */
  router.post('/:offerId/respond', async (req, res, next) => {
    try {
      const { offerId } = req.params;
      const { userId, response } = (req.body ?? {}) as {
        userId?: string;
        response?: string;
      };
      if (!offerId || !userId) {
        res.status(400).json({ error: 'Missing offerId or userId' });
        return;
      }
      if (!response || !VALID_RESPONSES.has(response as PromotionOfferResponse)) {
        res.status(400).json({
          error: `Invalid response. Expected one of: ${Array.from(VALID_RESPONSES).join(', ')}`,
        });
        return;
      }

      // Ownership: the offer must belong to the requesting user. The
      // session-auth middleware sets `req.authenticatedUserId`; cross-
      // check against the body's userId (which is also cross-checked
      // against the offer's user_id below).
      const sessionUserId = (req as { authenticatedUserId?: string }).authenticatedUserId;
      if (sessionUserId && sessionUserId !== userId) {
        res.status(403).json({ error: 'Session user does not match body userId' });
        return;
      }

      // Branch on response type. Accept runs through `acceptAtomic`
      // (single transaction guarding offer state, server tier, and
      // the tier bump). Rejected/dismissed are simpler: just mark
      // responded — no tier promotion, no cross-table race.
      if (response === 'accepted') {
        // We don't have offer.server_id yet (haven't looked it up),
        // but acceptAtomic needs it. Do a narrow read first solely
        // to get server_id + expected current_tier + proposed_tier.
        // The actual atomicity guarantee comes from acceptAtomic's
        // SELECT FOR UPDATE inside the transaction — this lookup
        // is non-authoritative.
        const offer = await promotionOffersRepository.findById(offerId);
        if (!offer) {
          res.status(404).json({ error: 'Offer not found' });
          return;
        }
        if (offer.user_id !== userId) {
          res.status(403).json({ error: 'Offer does not belong to this user' });
          return;
        }
        const outcome = await promotionOffersRepository.acceptAtomic({
          offerId,
          serverId: offer.server_id,
          expectedCurrentTier: offer.current_tier,
          proposedTier: offer.proposed_tier,
        });
        if (outcome.notFound) {
          res.status(404).json({ error: 'Offer not found' });
          return;
        }
        if (outcome.alreadyResponded) {
          res.status(409).json({
            error: 'Offer already responded',
            response: outcome.row?.response ?? null,
          });
          return;
        }
        if (outcome.serverMissing) {
          res.status(409).json({
            error: 'Server no longer exists; offer rejected',
          });
          return;
        }
        if (outcome.staleSnapshot) {
          res.status(409).json({
            error:
              `Server tier has changed since offer (was ${offer.current_tier}); offer rejected`,
          });
          return;
        }
        log.info('Promotion accepted; server tier updated', {
          userId,
          serverId: offer.server_id,
          fromTier: offer.current_tier,
          toTier: offer.proposed_tier,
        });
        res.json({ ok: true, promotionApplied: true, response: 'accepted' });
        return;
      }

      // Rejected / dismissed: simple mark-responded with the
      // standard race-safe UPDATE.
      const offer = await promotionOffersRepository.findById(offerId);
      if (!offer) {
        res.status(404).json({ error: 'Offer not found' });
        return;
      }
      if (offer.user_id !== userId) {
        res.status(403).json({ error: 'Offer does not belong to this user' });
        return;
      }
      if (offer.responded_at !== null) {
        res.status(409).json({
          error: 'Offer already responded',
          response: offer.response,
        });
        return;
      }
      const updated = await promotionOffersRepository.markResponded(
        offerId,
        response as PromotionOfferResponse,
      );
      if (!updated) {
        // Race: someone else responded between our findById and now.
        res.status(409).json({ error: 'Offer already responded' });
        return;
      }

      res.json({ ok: true, promotionApplied: false, response });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Periodic sweeper that watches `promotion_offers` for newly-inserted
 * rows and emits `capability:promotion-offered` SSE for live dashboard
 * connections. Purely a UX optimization on top of the polling surface
 * — a user with a closed tab will still see the offer next time they
 * open the dashboard (from the GET endpoint).
 *
 * Starts on app boot via `startPromotionOffersSweeper`. The sweeper
 * tracks the most-recent `offered_at` it has seen and queries for
 * anything newer on each tick. Catching up after an API restart
 * picks up from the boot timestamp — pre-restart offers are NOT
 * re-emitted (the dashboard will pick them up via the next poll).
 */
const SWEEP_INTERVAL_MS = 30_000;

let sweeperHandle: NodeJS.Timeout | null = null;
let lastSweepCutoff = new Date();

export async function sweepPromotionOffersOnce(now: Date = new Date()): Promise<number> {
  // Snapshot the cutoff but DO NOT advance it until we know the read
  // succeeded. Copilot caught the prior shape — advancing before the
  // read meant that if `listOfferedSince` threw, the failed window
  // would be permanently skipped by SSE (dashboard polling would
  // still pick it up, but live tabs would miss it forever).
  const since = lastSweepCutoff;
  try {
    const offers = await promotionOffersRepository.listOfferedSince(since);
    for (const offer of offers) {
      // Shape matches what the legacy SSE listener expects (serverName,
      // currentTier, etc.) PLUS the new `offerId` so the modal can
      // call /api/promotion-offers/:offerId/respond on accept.
      sseManager.emit(offer.user_id, SSE_CAPABILITY_PROMOTION_OFFERED, {
        offerId: offer.id,
        serverId: offer.server_id,
        serverName: offer.server_name,
        currentTier: offer.current_tier,
        proposedTier: offer.proposed_tier,
        reason: offer.reason,
        decisionsObservedCount: offer.decisions_observed_count,
        approvedCount: offer.approved_count,
      });
    }
    // Advance the cutoff only after the read succeeded so a failed
    // tick re-attempts the same window on the next sweep.
    lastSweepCutoff = now;
    return offers.length;
  } catch (err) {
    log.warn('Promotion-offers sweep failed; cutoff not advanced (will retry same window)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export function startPromotionOffersSweeper(): void {
  if (sweeperHandle) return;
  lastSweepCutoff = new Date();
  sweeperHandle = setInterval(() => {
    void sweepPromotionOffersOnce();
  }, SWEEP_INTERVAL_MS);
  // Avoid keeping the process alive solely because of this timer.
  sweeperHandle.unref?.();
}

export function stopPromotionOffersSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
}
