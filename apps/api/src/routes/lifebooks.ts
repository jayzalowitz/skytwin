import { Router } from 'express';
import { lifebookRepository, mempalaceRepository } from '@skytwin/db';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

/**
 * Routes for the Emergent Lifebooks surface (#193 Child 1).
 *
 *   GET    /api/lifebooks/:userId                       — list visible lifebooks
 *   GET    /api/lifebooks/:userId/all                   — list all (including hidden)
 *   GET    /api/lifebooks/:userId/:domainName           — single lifebook + wing summary
 *   POST   /api/lifebooks/:userId/:domainName/hide      — hide from dashboards
 *   POST   /api/lifebooks/:userId/:domainName/unhide    — restore visibility
 *   POST   /api/lifebooks/:userId/:domainName/importance       — set override (#321)
 *   DELETE /api/lifebooks/:userId/:domainName/importance       — clear override (#321)
 *
 * The worker is the only writer of lifebook *content*; this router
 * adjusts visibility + user-set importance overrides. Domain detection
 * itself is intentionally not user-driven — it emerges from the user's
 * actual memory each weekly run.
 */
export function createLifebooksRouter(): Router {
  const router = Router();
  bindUserIdParamOwnership(router);

  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }
      const rows = await lifebookRepository.listVisible(userId);
      res.json({ lifebooks: rows.map(rowToJson) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:userId/all', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }
      const rows = await lifebookRepository.listAll(userId);
      res.json({ lifebooks: rows.map(rowToJson) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:userId/:domainName', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      const row = await lifebookRepository.findByDomain(userId, decodeURIComponent(domainName));
      if (!row) {
        res.status(404).json({ error: 'Lifebook not found' });
        return;
      }
      let wingSummary: { roomCount: number; drawerCount: number } | null = null;
      if (row.wing_id !== null) {
        const rooms = await mempalaceRepository.getRooms(row.wing_id);
        const drawers = await mempalaceRepository.getDrawers(userId, {
          wingId: row.wing_id,
          limit: 1,
        });
        wingSummary = { roomCount: rooms.length, drawerCount: drawers.length };
      }
      res.json({ lifebook: rowToJson(row), wingSummary });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:userId/:domainName/hide', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      const updated = await lifebookRepository.hide(userId, decodeURIComponent(domainName));
      res.json({ updated });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:userId/:domainName/unhide', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      const updated = await lifebookRepository.unhide(userId, decodeURIComponent(domainName));
      res.json({ updated });
    } catch (err) {
      next(err);
    }
  });

  /**
   * #321: POST /:userId/:domainName/importance — set a user override.
   * Body: { value: 'core'|'secondary'|'emerging', decayDays?: number }
   * The override wins over the extractor's automatic pick for the
   * decayDays window (default 90; 0 = never auto-decay).
   *
   * 404 when the lifebook doesn't exist; 400 on invalid value.
   */
  router.post('/:userId/:domainName/importance', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      const body = req.body as { value?: unknown; decayDays?: unknown } | undefined;
      if (
        body?.value !== 'core' &&
        body?.value !== 'secondary' &&
        body?.value !== 'emerging'
      ) {
        res.status(400).json({
          error: "value must be one of 'core' | 'secondary' | 'emerging'",
        });
        return;
      }
      const decayDays =
        typeof body.decayDays === 'number' && Number.isFinite(body.decayDays) && body.decayDays >= 0
          ? Math.floor(body.decayDays)
          : 90;
      const updated = await lifebookRepository.setImportanceOverride(
        userId,
        decodeURIComponent(domainName),
        body.value,
        decayDays,
      );
      if (!updated) {
        res.status(404).json({ error: 'Lifebook not found' });
        return;
      }
      res.json({ lifebook: rowToJson(updated) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * #321: DELETE /:userId/:domainName/importance — clear the override.
   * The `importance` column stays at its current value; the next
   * extractor run sets it back to whatever the prompt picks.
   * Idempotent.
   */
  router.delete('/:userId/:domainName/importance', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      const updated = await lifebookRepository.clearImportanceOverride(
        userId,
        decodeURIComponent(domainName),
      );
      if (!updated) {
        res.status(404).json({ error: 'Lifebook not found' });
        return;
      }
      res.json({ lifebook: rowToJson(updated) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

interface LifebookJson {
  id: string;
  domainName: string;
  importance: 'core' | 'secondary' | 'emerging';
  sampleSignals: string[];
  suggestedCapabilities: string[];
  wingId: string | null;
  detectedAt: string;
  lastSeenAt: string;
  hidden: boolean;
  /**
   * #321: surfaced for UI rendering so the detail page / dashboard card
   * can show "set by you" instead of "auto-detected" and offer a
   * Clear button. `null` when no user override exists.
   */
  importanceOverride: {
    value: 'core' | 'secondary' | 'emerging';
    setAt: string;
    decayDays: number;
  } | null;
}

/**
 * Same freshness check as `lifebookRepository.upsert`'s CASE: an
 * override counts as "currently honored" only if `decayDays === 0`
 * (never auto-decay) OR `setAt + decayDays` is in the future.
 *
 * Without this check `rowToJson` would surface stale overrides that
 * the extractor no longer respects, and the UI would label such
 * lifebooks as "set by you" while the importance had already
 * decayed back to the extractor's pick. (Copilot caught it.)
 */
function isOverrideFresh(
  override: { setAt: string; decayDays: number },
  now: Date = new Date(),
): boolean {
  if (override.decayDays === 0) return true;
  const setAt = new Date(override.setAt);
  if (Number.isNaN(setAt.getTime())) return false;
  const deadlineMs = setAt.getTime() + override.decayDays * 24 * 60 * 60 * 1000;
  return now.getTime() < deadlineMs;
}

function rowToJson(r: import('@skytwin/db').LifebookRow): LifebookJson {
  const override = r.metadata?.importanceOverride;
  const fresh = override && isOverrideFresh(override);
  return {
    id: r.id,
    domainName: r.domain_name,
    importance: r.importance,
    sampleSignals: r.sample_signals,
    suggestedCapabilities: r.suggested_capabilities,
    wingId: r.wing_id,
    detectedAt: r.detected_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    hidden: r.hidden_at !== null,
    importanceOverride: fresh
      ? {
          value: override.value,
          setAt: override.setAt,
          decayDays: override.decayDays,
        }
      : null,
  };
}
