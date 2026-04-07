import { Router } from 'express';
import { mempalaceRepository } from '@skytwin/db';
import type { PalaceStatus } from '@skytwin/shared-types';

/**
 * Create the memory palace router.
 *
 * GET  /mempalace/:userId/status           — Palace overview stats
 * GET  /mempalace/:userId/wings            — List all wings
 * GET  /mempalace/:userId/wings/:wingId/rooms — List rooms in a wing
 * GET  /mempalace/:userId/drawers          — List/search drawers
 * POST /mempalace/:userId/drawers          — Create a drawer
 * GET  /mempalace/:userId/tunnels          — List cross-wing tunnels
 * GET  /mempalace/:userId/episodes         — List episodic memories
 * GET  /mempalace/:userId/episodes/search  — Search episodes
 * GET  /mempalace/:userId/kg/entities      — List knowledge graph entities
 * GET  /mempalace/:userId/kg/triples       — Query knowledge graph triples
 * POST /mempalace/:userId/kg/entities      — Create/update an entity
 * POST /mempalace/:userId/kg/triples       — Add a triple
 */
export function createMempalaceRouter(): Router {
  const router = Router();

  // ── Palace Status ──────────────────────────────────────────────

  router.get('/:userId/status', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const status = await mempalaceRepository.getStatus(userId);
      const palaceStatus: PalaceStatus = {
        userId,
        ...status,
        oldestMemory: status.oldestMemory ?? undefined,
        newestMemory: status.newestMemory ?? undefined,
      };

      res.json({ status: palaceStatus });
    } catch (error) {
      next(error);
    }
  });

  // ── Wings ──────────────────────────────────────────────────────

  router.get('/:userId/wings', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const wings = await mempalaceRepository.getWings(userId);
      res.json({ wings });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:userId/wings/:wingId/rooms', async (req, res, next) => {
    try {
      const { wingId } = req.params;
      if (!wingId) {
        res.status(400).json({ error: 'Missing wingId parameter' });
        return;
      }

      const rooms = await mempalaceRepository.getRooms(wingId);
      res.json({ rooms });
    } catch (error) {
      next(error);
    }
  });

  // ── Drawers ────────────────────────────────────────────────────

  router.get('/:userId/drawers', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const search = req.query['search'] as string | undefined;
      const hall = req.query['hall'] as string | undefined;
      const wingId = req.query['wingId'] as string | undefined;
      const roomId = req.query['roomId'] as string | undefined;
      const limit = parseInt(req.query['limit'] as string ?? '50', 10);

      if (search) {
        const terms = search.split(/\s+/).filter((t) => t.length > 0);
        const drawers = await mempalaceRepository.searchDrawers(userId, terms, limit);
        res.json({ drawers, total: drawers.length });
      } else {
        const drawers = await mempalaceRepository.getDrawers(userId, {
          hall,
          wingId,
          roomId,
          limit,
        });
        res.json({ drawers, total: drawers.length });
      }
    } catch (error) {
      next(error);
    }
  });

  router.post('/:userId/drawers', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const { roomId, wingId, hall, content, metadata, sourceType, sourceId } = body;

      if (!roomId || !wingId || !hall || !content) {
        res.status(400).json({ error: 'Missing required fields: roomId, wingId, hall, content' });
        return;
      }

      const drawer = await mempalaceRepository.createDrawer({
        roomId: roomId as string,
        wingId: wingId as string,
        userId,
        hall: hall as string,
        content: content as string,
        metadata: (metadata as Record<string, unknown>) ?? {},
        sourceType: (sourceType as string) ?? 'explicit',
        sourceId: sourceId as string | undefined,
      });

      res.status(201).json({ drawer });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:userId/drawers/:drawerId', async (req, res, next) => {
    try {
      const { drawerId } = req.params;
      if (!drawerId) {
        res.status(400).json({ error: 'Missing drawerId parameter' });
        return;
      }

      const deleted = await mempalaceRepository.deleteDrawer(drawerId);
      res.json({ deleted });
    } catch (error) {
      next(error);
    }
  });

  // ── Tunnels ────────────────────────────────────────────────────

  router.get('/:userId/tunnels', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const tunnels = await mempalaceRepository.getTunnels(userId);
      res.json({ tunnels });
    } catch (error) {
      next(error);
    }
  });

  // ── Episodic Memories ──────────────────────────────────────────

  router.get('/:userId/episodes', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const domain = req.query['domain'] as string | undefined;
      const situationType = req.query['situationType'] as string | undefined;
      const limit = parseInt(req.query['limit'] as string ?? '50', 10);
      const minUtility = req.query['minUtility']
        ? parseFloat(req.query['minUtility'] as string)
        : undefined;

      const episodes = await mempalaceRepository.getEpisodes(userId, {
        domain,
        situationType,
        limit,
        minUtility,
      });

      res.json({ episodes, total: episodes.length });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:userId/episodes/search', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const search = req.query['q'] as string;
      if (!search) {
        res.status(400).json({ error: 'Missing q (search query) parameter' });
        return;
      }

      const limit = parseInt(req.query['limit'] as string ?? '20', 10);
      const terms = search.split(/\s+/).filter((t) => t.length > 0);
      const episodes = await mempalaceRepository.searchEpisodes(userId, terms, limit);

      res.json({ episodes, total: episodes.length });
    } catch (error) {
      next(error);
    }
  });

  // ── Knowledge Graph ────────────────────────────────────────────

  router.get('/:userId/kg/entities', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const entityType = req.query['type'] as string | undefined;
      const entities = await mempalaceRepository.getEntities(userId, entityType);

      res.json({ entities, total: entities.length });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:userId/kg/entities', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const { name, entityType, properties, aliases } = body;

      if (!name || !entityType) {
        res.status(400).json({ error: 'Missing required fields: name, entityType' });
        return;
      }

      const entity = await mempalaceRepository.upsertEntity({
        userId,
        name: name as string,
        entityType: entityType as string,
        properties: (properties as Record<string, unknown>) ?? {},
        aliases: (aliases as string[]) ?? [],
      });

      res.status(201).json({ entity });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:userId/kg/triples', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const subject = req.query['subject'] as string | undefined;
      const predicate = req.query['predicate'] as string | undefined;
      const object = req.query['object'] as string | undefined;
      const asOf = req.query['asOf'] ? new Date(req.query['asOf'] as string) : undefined;
      const limit = parseInt(req.query['limit'] as string ?? '100', 10);

      const triples = await mempalaceRepository.queryTriples(userId, {
        subject,
        predicate,
        object,
        asOf,
        limit,
      });

      res.json({ triples, total: triples.length });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:userId/kg/triples', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const { subject, predicate, object, confidence, validFrom } = body;

      if (!subject || !predicate || !object) {
        res.status(400).json({ error: 'Missing required fields: subject, predicate, object' });
        return;
      }

      const triple = await mempalaceRepository.addTriple({
        userId,
        subject: subject as string,
        predicate: predicate as string,
        object: object as string,
        confidence: (confidence as string) ?? 'moderate',
        validFrom: validFrom ? new Date(validFrom as string) : undefined,
      });

      res.status(201).json({ triple });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
