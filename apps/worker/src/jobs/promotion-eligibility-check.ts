import { createLogger } from '@skytwin/core';
import {
  mcpServerRepository,
  promotionOffersRepository,
  trustTierAuditRepository,
  query,
} from '@skytwin/db';
import { TrustTierEngine } from '@skytwin/policy-engine';
import { PROMOTION_THRESHOLDS } from '@skytwin/shared-types';
import type { TrustTier } from '@skytwin/shared-types';

const log = createLogger('worker:promotion-eligibility-check');

/**
 * Checks all active MCP servers for tier promotion eligibility and
 * writes a `promotion_offers` row for each eligible server (#310,
 * Option B). The dashboard polls the durable surface; the API may
 * also emit SSE on inserts as a UX optimization for live connections.
 *
 * Before #310 this job emitted SSE directly via an injected `emitter`,
 * which the worker had no clean way to provide (the `sseManager`
 * lives in apps/api, not the worker). The DB-side ceremony cuts that
 * dependency: the worker only needs the `promotionOffersRepository`,
 * which it already has.
 *
 * Idempotency. `promotionOffersRepository.createIfPending` is
 * INSERT ... ON CONFLICT DO NOTHING against the partial unique
 * index on `(server_id, proposed_tier) WHERE responded_at IS NULL`,
 * so a re-run of this job for an already-pending offer is a no-op.
 * The job can therefore run on any cadence — even concurrently with
 * a previous tick — without producing duplicates.
 *
 * Cadence (per #304 wiring): once daily. The trust-tier ceremony is
 * a slow ladder by design; hourly was the original spec but daily
 * avoids hammering the eligibility query for users with hundreds of
 * servers, and matches the relationship-tier-backfill cadence the
 * worker already runs.
 */

export interface PromotionEligibilityCheckResult {
  /** How many active servers were evaluated. */
  evaluated: number;
  /** How many new pending offers were inserted (excludes dedup'd). */
  offered: number;
  /** How many would-have-offered but were already pending (dedup). */
  alreadyPending: number;
}

export async function runPromotionEligibilityCheckJob(): Promise<PromotionEligibilityCheckResult> {
  log.info('Running promotion eligibility check');

  // Fetch all active servers that have not been paused from auto-promotion
  const activeServers = await mcpServerRepository.listActive();
  const now = new Date();

  const engine = new TrustTierEngine();
  let evaluated = 0;
  let offered = 0;
  let alreadyPending = 0;

  for (const server of activeServers) {
    try {
      // Skip if auto-promotion ceremony is paused for this server
      if (server.auto_promote_paused_until && server.auto_promote_paused_until > now) {
        continue;
      }

      const currentTier = server.trust_tier as TrustTier;
      const threshold = PROMOTION_THRESHOLDS[currentTier];
      if (!threshold) continue; // No promotion path (e.g. high_autonomy)

      // Gather approval stats from provenance nodes for this server
      const statsResult = await query<{ total: string; approved: string }>(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE (payload->>'approved')::boolean = true) AS approved
         FROM capability_provenance_nodes
         WHERE server_id = $1 AND node_type = 'action' AND user_id = $2`,
        [server.id, server.user_id],
      );
      const statsRow = statsResult.rows[0];
      const totalActions = parseInt(statsRow?.total ?? '0', 10);
      const approvedActions = parseInt(statsRow?.approved ?? '0', 10);
      const approvalRatio = totalActions > 0 ? approvedActions / totalActions : 0;

      const recentResult = await query<{ payload: unknown }>(
        `SELECT payload FROM capability_provenance_nodes
         WHERE server_id = $1 AND node_type = 'action' AND user_id = $2
         ORDER BY occurred_at DESC LIMIT ${threshold.consecutiveApprovals * 2}`,
        [server.id, server.user_id],
      );
      let consecutiveApprovals = 0;
      for (const row of recentResult.rows) {
        const p = row.payload as Record<string, unknown> | null;
        if (p?.['approved'] === true) {
          consecutiveApprovals++;
        } else {
          break;
        }
      }

      // Count only servers where we actually completed the eligibility
      // computation. A pre-evaluation query failure landed in the catch
      // block and never incremented this counter.
      evaluated++;

      // Soak floor (spec 10 Part C, #483): populate hoursInCurrentTier so the
      // engine actually enforces minDurationInTierHours. Previously omitted, so
      // a user could be offered observer->suggest within one session. Measured
      // from the last tier change or account creation (fail-safe 0 = blocked).
      const hoursInCurrentTier = await trustTierAuditRepository.hoursInCurrentTier(
        server.user_id,
      );

      const evaluation = engine.evaluateProgression(currentTier, {
        totalApprovals: approvedActions,
        totalRejections: totalActions - approvedActions,
        totalUndos: 0,
        consecutiveApprovals,
        recentRejections: 0,
        hasCriticalUndo: false,
        approvalRatio,
        hoursInCurrentTier,
      });

      if (evaluation.shouldChange && evaluation.recommendedTier) {
        const created = await promotionOffersRepository.createIfPending({
          userId: server.user_id,
          serverId: server.id,
          currentTier,
          proposedTier: evaluation.recommendedTier,
          reason: evaluation.reason,
          decisionsObservedCount: totalActions,
          approvedCount: approvedActions,
        });
        if (created) {
          offered++;
          log.info('Promotion ceremony offered', {
            offerId: created.id,
            serverId: server.id,
            userId: server.user_id,
            currentTier,
            proposedTier: evaluation.recommendedTier,
          });
        } else {
          alreadyPending++;
        }
      }
    } catch (err) {
      log.warn('Error checking promotion eligibility for server', {
        serverId: server.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(
    `Promotion eligibility check complete: ${offered} new offer(s), ${alreadyPending} already pending, ${evaluated} evaluated`,
  );
  return { evaluated, offered, alreadyPending };
}
