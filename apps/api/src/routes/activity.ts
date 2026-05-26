import { Router } from 'express';
import {
  signalRepository,
  decisionRepository,
  feedbackRepository,
} from '@skytwin/db';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';

/**
 * Recent-activity timeline (#391).
 *
 * Unified view that pulls signals + decisions + feedback for the
 * user, merges them by event timestamp, and returns a flat
 * chronological list. The dashboard's "Activity" tab (follow-up
 * PR — UI is intentionally NOT in this slice) will render the
 * payload as a timeline.
 *
 * Query params:
 *   `?hours=24`   — lookback window in hours, default 24, capped at 720 (30d).
 *   `?limit=200`  — total rows to return after merge, default 200, capped at 500.
 *
 * The endpoint does NO filter logic beyond the time window and the
 * row cap — sort + filter (by kind / domain / outcome / risk tier)
 * is a client-side concern at this volume. If a future workload
 * justifies a SQL-side filter we can extend the query params then.
 *
 * Auth: per-user, gated by the existing `sessionAuth +
 * requireOwnership` middleware that wraps every `/:userId` route.
 *
 * Privacy: only returns the caller's own user_id rows — three
 * separate per-user repository queries, no cross-user union.
 */

type ActivityKind = 'signal' | 'decision' | 'feedback';

interface ActivityEvent {
  /** Stable identifier for de-dupe / client-side key. */
  id: string;
  kind: ActivityKind;
  /** ISO timestamp. */
  at: string;
  /** Free-text one-liner the UI can render without further lookup. */
  summary: string;
  /** Domain / source for client-side faceting. Optional. */
  domain?: string | null;
  /**
   * Decision id (when kind is 'decision' OR when a feedback /
   * signal links to one) so the future UI can drill into the
   * ExplanationRecord without re-fetching anything else.
   */
  decisionId?: string | null;
}

const DEFAULT_HOURS = 24;
const MAX_HOURS = 720; // 30 days
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export function createActivityRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);

  /**
   * GET /api/activity/:userId
   * → `{ events: ActivityEvent[], total: number, hours: number, limit: number }`
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params as { userId: string };
      const hours = clampInt(req.query['hours'] as string | undefined, DEFAULT_HOURS, 1, MAX_HOURS);
      const limit = clampInt(req.query['limit'] as string | undefined, DEFAULT_LIMIT, 1, MAX_LIMIT);
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);

      const [signals, decisions, feedback] = await Promise.allSettled([
        signalRepository.getRecent(userId, undefined, hours),
        decisionRepository.findByUser(userId, { from: since, limit }),
        feedbackRepository.findByUser(userId, { limit }),
      ]);

      const events: ActivityEvent[] = [];

      if (signals.status === 'fulfilled') {
        for (const s of signals.value) {
          events.push({
            id: `sig:${s.id}`,
            kind: 'signal',
            at: s.timestamp.toISOString(),
            summary: `${s.source}/${s.type}`,
            domain: s.domain ?? null,
          });
        }
      }

      if (decisions.status === 'fulfilled') {
        for (const d of decisions.value) {
          events.push({
            id: `dec:${d.id}`,
            kind: 'decision',
            at: (d.created_at ?? since).toISOString(),
            // DecisionRow has no `summary` column — synthesise one from
            // situation_type + domain. The future UI can fetch the
            // ExplanationRecord via decisionId for the rich copy.
            summary: `${d.situation_type ?? 'decision'} (${d.domain ?? 'unknown'})`,
            domain: d.domain ?? null,
            decisionId: d.id,
          });
        }
      }

      if (feedback.status === 'fulfilled') {
        for (const f of feedback.value) {
          // Feedback rows don't carry a domain; the linked decision does,
          // but joining here would be N+1. The client can resolve the
          // domain via the linked decisionId if it needs to facet.
          events.push({
            id: `fb:${f.id}`,
            kind: 'feedback',
            at: (f.created_at ?? since).toISOString(),
            summary: `${f.type} (decision ${String(f.decision_id ?? '').slice(0, 8) || 'unknown'})`,
            decisionId: (f.decision_id as string | null) ?? null,
          });
        }
      }

      // Filter to the lookback window in case decision/feedback
      // repos returned older rows (their findByUser doesn't bound on
      // time by default).
      const sinceMs = since.getTime();
      const inWindow = events.filter((e) => Date.parse(e.at) >= sinceMs);
      // Newest first.
      inWindow.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const trimmed = inWindow.slice(0, limit);

      res.json({
        events: trimmed,
        total: trimmed.length,
        hours,
        limit,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
