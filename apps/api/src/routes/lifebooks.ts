import { Router } from 'express';
import { lifebookRepository, mempalaceRepository } from '@skytwin/db';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

/**
 * Routes for the Emergent Lifebooks surface (#193 Child 1).
 *
 *   GET    /api/lifebooks/:userId                  — list visible lifebooks
 *   GET    /api/lifebooks/:userId/all              — list all (including hidden)
 *   GET    /api/lifebooks/:userId/:domainName      — single lifebook + wing summary
 *   POST   /api/lifebooks/:userId/:domainName/hide   — hide from dashboards
 *   POST   /api/lifebooks/:userId/:domainName/unhide — restore visibility
 *
 * The worker is the only writer of lifebook *content*; this router only
 * adjusts visibility. Domain detection is intentionally not user-driven —
 * it emerges from the user's actual memory each weekly run.
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
}

function rowToJson(r: import('@skytwin/db').LifebookRow): LifebookJson {
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
  };
}
