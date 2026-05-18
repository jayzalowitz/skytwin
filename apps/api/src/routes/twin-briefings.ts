import { Router } from 'express';
import { briefingRepository, lifebookRepository } from '@skytwin/db';
import { createLogger } from '@skytwin/core';

const log = createLogger('api:twin-briefings');

/**
 * Twin Briefing routes (issue #177).
 *
 * Endpoints (all under /api/twin-briefings/…):
 *
 *   GET  /latest?cadence=daily|weekly   — latest briefing for the user
 *   GET  /?cadence=&limit=              — list briefings
 *   POST /:id/read                      — mark a briefing as read
 *
 * All endpoints require a userId (from session or query param for dev).
 * Ownership is enforced — a user can only read their own briefings.
 */
export function createTwinBriefingsRouter(): Router {
  const router = Router();

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function getUserId(req: import('express').Request): string | undefined {
    return (req as unknown as { user?: { id?: string } }).user?.id
      ?? (req.query['userId'] as string | undefined);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /latest?cadence=daily|weekly
  //
  // Returns the latest GLOBAL briefing for the authenticated user, plus
  // #320: a `sections[]` fold — one entry per visible Lifebook with its
  // most-recent per-domain briefing. Sections are ordered by Lifebook
  // importance (core → secondary → emerging), then by most-recent first
  // within each tier. Lifebooks with no briefing yet are omitted (no
  // empty-state at the section level; the dashboard renders the global
  // briefing without that section).
  //
  // Response shape (backward-additive on the original):
  //   { briefing: TwinBriefingRow | null,
  //     sections: Array<{ lifebookId, domainName, importance, briefing }> }
  //
  // Three parallel queries + a join in JS — cheaper than per-Lifebook
  // round-trips, and the per-call cost is bounded by the user's
  // visible-Lifebook count (typically < 10).
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/latest', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const rawCadence = req.query['cadence'];
      const cadence = rawCadence === 'daily' || rawCadence === 'weekly'
        ? rawCadence
        : undefined;

      const [briefing, perLifebookBriefings, visibleLifebooks] = await Promise.all([
        briefingRepository.getLatestForUser(userId, cadence),
        briefingRepository.getLatestPerLifebook(userId, cadence),
        lifebookRepository.listVisible(userId),
      ]);

      // Ownership check on the global briefing (per-Lifebook ones are
      // already scoped by user_id at query time).
      if (briefing && briefing.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      // Join: walk visibleLifebooks in importance order; attach the
      // matching per-domain briefing when one exists. Lifebooks
      // without a briefing are omitted from sections[]. The
      // listVisible repo method already returns rows in
      // core → secondary → emerging order, then last_seen_at DESC.
      const briefingByDomain = new Map(
        perLifebookBriefings.map((b) => [b.domain_name as string, b]),
      );
      const sections = visibleLifebooks
        .map((lb) => {
          const lifebookBriefing = briefingByDomain.get(lb.domain_name);
          if (!lifebookBriefing) return null;
          return {
            lifebookId: lb.id,
            domainName: lb.domain_name,
            importance: lb.importance,
            briefing: lifebookBriefing,
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);

      res.json({ briefing: briefing ?? null, sections });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /lifebook/:domain/latest?cadence=daily|weekly
  // #193 follow-up: return the most recent briefing scoped to a Lifebook
  // domain. NULL when none exists yet (the worker hasn't emitted one,
  // the domain is too new, or the domain had zero events in the window).
  // The lifebook page renders the prose when present and a friendly
  // "no briefing yet" affordance when not.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/lifebook/:domain/latest', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }
      const { domain } = req.params;
      if (!domain || domain.length === 0) {
        res.status(400).json({ error: 'domain is required' });
        return;
      }

      const rawCadence = req.query['cadence'];
      const cadence = rawCadence === 'daily' || rawCadence === 'weekly'
        ? rawCadence
        : undefined;

      const briefing = await briefingRepository.getLatestForUserDomain(
        userId,
        domain,
        cadence,
      );
      if (!briefing) {
        res.json({ briefing: null });
        return;
      }
      if (briefing.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      res.json({ briefing });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /?cadence=&limit=
  // List briefings for the user, newest-first.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const rawCadence = req.query['cadence'];
      const cadence = rawCadence === 'daily' || rawCadence === 'weekly'
        ? rawCadence
        : undefined;

      const rawLimit = req.query['limit'];
      const limit = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit)
        ? Math.min(parseInt(rawLimit, 10), 100)
        : 20;

      const briefings = await briefingRepository.listForUser(userId, { cadence, limit });
      res.json({ briefings });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /:id/read
  // Mark a briefing as read. Verifies ownership before mutating.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/read', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // Fetch the briefing first for ownership check
      const rows = await briefingRepository.listForUser(userId, { limit: 200 });
      const target = rows.find((r) => r.id === id);

      if (!target) {
        res.status(404).json({ error: 'Briefing not found' });
        return;
      }

      if (target.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this briefing' });
        return;
      }

      const updated = await briefingRepository.markRead(id);
      log.info('Briefing marked read', { briefingId: id });
      res.json({ briefing: updated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
