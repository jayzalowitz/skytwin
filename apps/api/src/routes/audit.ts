import { Router } from 'express';
import {
  trustTierAuditRepository,
  spendRepository,
  preferenceHistoryRepository,
} from '@skytwin/db';

interface AuditEntry {
  id: string;
  type: 'tier_change' | 'spend_event' | 'preference_change';
  timestamp: Date;
  description: string;
  detail: Record<string, unknown>;
}

/**
 * Create the audit timeline router.
 *
 * Merges trust tier changes, spend events, and preference evolution
 * into a single chronological feed.
 */
export function createAuditRouter(): Router {
  const router = Router();

  /**
   * GET /api/audit/:userId
   *
   * Unified audit timeline for a user.
   * Query params: type (tier_change|spend_event|preference_change), limit, from, to
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const typeFilter = req.query['type'] as string | undefined;
      const limit = parseInt(req.query['limit'] as string ?? '100', 10);
      const from = req.query['from'] as string | undefined;
      const to = req.query['to'] as string | undefined;

      const entries: AuditEntry[] = [];

      // Fetch trust tier changes
      if (!typeFilter || typeFilter === 'tier_change') {
        const tierAudits = await trustTierAuditRepository.findByUser(userId, limit);
        for (const audit of tierAudits) {
          entries.push({
            id: audit.id,
            type: 'tier_change',
            timestamp: audit.created_at,
            description: `Trust tier ${audit.direction}: ${audit.old_tier} → ${audit.new_tier}`,
            detail: {
              oldTier: audit.old_tier,
              newTier: audit.new_tier,
              direction: audit.direction,
              reason: audit.trigger_reason,
            },
          });
        }
      }

      // Fetch spend events
      if (!typeFilter || typeFilter === 'spend_event') {
        const windowHours = 24 * 30; // 30 days
        const spendEvents = await spendRepository.findByUser(userId, windowHours);
        for (const event of spendEvents) {
          entries.push({
            id: event.id,
            type: 'spend_event',
            timestamp: event.recorded_at,
            description: `Spend: ${event.estimated_cost_cents}¢ estimated${event.actual_cost_cents ? `, ${event.actual_cost_cents}¢ actual` : ''}`,
            detail: {
              actionId: event.action_id,
              decisionId: event.decision_id,
              estimatedCostCents: event.estimated_cost_cents,
              actualCostCents: event.actual_cost_cents,
              reconciled: !!event.reconciled_at,
            },
          });
        }
      }

      // Fetch preference changes
      if (!typeFilter || typeFilter === 'preference_change') {
        const prefChanges = await preferenceHistoryRepository.getForUser(userId, limit);
        for (const change of prefChanges) {
          entries.push({
            id: change.id,
            type: 'preference_change',
            timestamp: change.changed_at,
            description: `Preference ${change.attribution_type}: confidence ${change.previous_confidence} → ${change.new_confidence}`,
            detail: {
              preferenceId: change.preference_id,
              previousValue: change.previous_value,
              newValue: change.new_value,
              previousConfidence: change.previous_confidence,
              newConfidence: change.new_confidence,
              attributionType: change.attribution_type,
            },
          });
        }
      }

      // Sort by timestamp descending and apply filters
      let filtered = entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      if (from) {
        const fromDate = new Date(from);
        if (isNaN(fromDate.getTime())) {
          res.status(400).json({ error: 'Invalid "from" date parameter' });
          return;
        }
        filtered = filtered.filter((e) => e.timestamp >= fromDate);
      }
      if (to) {
        const toDate = new Date(to);
        if (isNaN(toDate.getTime())) {
          res.status(400).json({ error: 'Invalid "to" date parameter' });
          return;
        }
        filtered = filtered.filter((e) => e.timestamp <= toDate);
      }

      filtered = filtered.slice(0, limit);

      res.json({
        entries: filtered.map((e) => ({
          ...e,
          timestamp: e.timestamp.toISOString(),
        })),
        total: filtered.length,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
