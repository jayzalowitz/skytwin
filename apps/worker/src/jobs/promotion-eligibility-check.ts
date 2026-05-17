import { createLogger } from '@skytwin/core';
import { mcpServerRepository, query } from '@skytwin/db';
import { TrustTierEngine } from '@skytwin/policy-engine';
import { PROMOTION_THRESHOLDS } from '@skytwin/shared-types';
import type { TrustTier } from '@skytwin/shared-types';

const log = createLogger('worker:promotion-eligibility-check');

/**
 * Checks all active MCP servers for tier promotion eligibility and emits
 * `capability:promotion-offered` SSE events to eligible users.
 *
 * Cadence: hourly. The promotion ceremony is suppressed for servers whose
 * auto_promote_paused_until is in the future.
 *
 * Wired into the worker poll loop in #304 with the fire-and-forget +
 * single-flight + revert-on-failure pattern from
 * `relationship-tier-scheduler.ts` (#282). The DB-side promotion
 * ceremony runs from the worker; the user-facing SSE "you were
 * promoted" emit is gated on an `emitter` being passed in, which the
 * worker currently doesn't (it has no direct SSE manager — that lives
 * in apps/api). A worker→API SSE bridge is a separate follow-up.
 *
 * The `emitter` parameter accepts any object with an `emit(userId, event, data)` method,
 * so the real sseManager can be injected in production and a stub in tests.
 */

export interface PromotionEligibilityCheckDeps {
  emitter?: {
    emit(userId: string, event: string, data: unknown): void;
  };
}

const SSE_CAPABILITY_PROMOTION_OFFERED = 'capability:promotion-offered';

export async function runPromotionEligibilityCheckJob(
  deps: PromotionEligibilityCheckDeps = {},
): Promise<void> {
  log.info('Running promotion eligibility check');

  // Fetch all active servers that have not been paused from auto-promotion
  const activeServers = await mcpServerRepository.listActive();
  const now = new Date();

  const engine = new TrustTierEngine();
  let offered = 0;

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

      const evaluation = engine.evaluateProgression(currentTier, {
        totalApprovals: approvedActions,
        totalRejections: totalActions - approvedActions,
        totalUndos: 0,
        consecutiveApprovals,
        recentRejections: 0,
        hasCriticalUndo: false,
        approvalRatio,
      });

      if (evaluation.shouldChange && evaluation.recommendedTier) {
        // Emit SSE event for the user to surface the promotion modal
        deps.emitter?.emit(server.user_id, SSE_CAPABILITY_PROMOTION_OFFERED, {
          serverId: server.id,
          serverName: server.display_name,
          currentTier,
          proposedTier: evaluation.recommendedTier,
          decisionsObservedCount: totalActions,
          approvedCount: approvedActions,
          reason: evaluation.reason,
        });
        offered++;
        log.info('Promotion ceremony offered', {
          serverId: server.id,
          userId: server.user_id,
          currentTier,
          proposedTier: evaluation.recommendedTier,
        });
      }
    } catch (err) {
      log.warn('Error checking promotion eligibility for server', {
        serverId: server.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(`Promotion eligibility check complete: ${offered} ceremony offer(s) emitted`);
}
