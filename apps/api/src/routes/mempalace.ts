import { Router } from 'express';
import { mempalaceRepository } from '@skytwin/db';
import type { PalaceStatus, MemoryHall, DrawerSource } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

// ── Input validation helpers ───────────────────────────────────────

const VALID_HALLS: ReadonlySet<string> = new Set<MemoryHall>([
  'facts', 'events', 'discoveries', 'preferences', 'advice', 'diary',
]);

const VALID_SOURCES: ReadonlySet<string> = new Set<DrawerSource>([
  'signal', 'decision', 'feedback', 'inference', 'explicit', 'mined',
]);

const VALID_CONFIDENCE: ReadonlySet<string> = new Set<string>(
  Object.values(ConfidenceLevel),
);

/** Coerce a query-string value to a safe positive integer within [1, max]. */
function safeInt(raw: unknown, fallback: number, max: number = 1000): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** Coerce a query-string value to a finite float within [min, max]. */
function safeFloat(raw: unknown, fallback: number | undefined, min: number = 0, max: number = 1): number | undefined {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

/** Validate that a string is a non-empty trimmed value. Returns null if invalid. */
function requireString(val: unknown, name: string): { value: string } | { error: string } {
  if (typeof val !== 'string' || val.trim().length === 0) {
    return { error: `${name} must be a non-empty string` };
  }
  return { value: val.trim() };
}

/** Parse a date from an ISO string. Returns undefined for missing, error message for invalid. */
function safeDateParam(raw: unknown): Date | undefined | string {
  if (raw === undefined || raw === null) return undefined;
  const d = new Date(String(raw));
  if (isNaN(d.getTime())) return 'Invalid date format';
  return d;
}

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
  bindUserIdParamOwnership(router);

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
      const limit = safeInt(req.query['limit'], 50, 500);

      if (hall && !VALID_HALLS.has(hall)) {
        res.status(400).json({ error: `Invalid hall. Must be one of: ${[...VALID_HALLS].join(', ')}` });
        return;
      }

      if (search) {
        const terms = search.split(/\s+/).filter((t) => t.length > 0);
        if (terms.length === 0) {
          res.status(400).json({ error: 'Search query must contain at least one non-empty term' });
          return;
        }
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

      if (typeof hall !== 'string' || !VALID_HALLS.has(hall)) {
        res.status(400).json({ error: `Invalid hall. Must be one of: ${[...VALID_HALLS].join(', ')}` });
        return;
      }

      const resolvedSource = typeof sourceType === 'string' ? sourceType : 'explicit';
      if (!VALID_SOURCES.has(resolvedSource)) {
        res.status(400).json({ error: `Invalid sourceType. Must be one of: ${[...VALID_SOURCES].join(', ')}` });
        return;
      }

      const roomIdStr = requireString(roomId, 'roomId');
      if ('error' in roomIdStr) { res.status(400).json({ error: roomIdStr.error }); return; }
      const wingIdStr = requireString(wingId, 'wingId');
      if ('error' in wingIdStr) { res.status(400).json({ error: wingIdStr.error }); return; }
      const contentStr = requireString(content, 'content');
      if ('error' in contentStr) { res.status(400).json({ error: contentStr.error }); return; }

      const drawer = await mempalaceRepository.createDrawer({
        roomId: roomIdStr.value,
        wingId: wingIdStr.value,
        userId,
        hall: hall as string,
        content: contentStr.value,
        metadata: (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
          ? metadata as Record<string, unknown>
          : {},
        sourceType: resolvedSource,
        sourceId: typeof sourceId === 'string' ? sourceId : undefined,
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
      const limit = safeInt(req.query['limit'], 50, 500);
      const minUtility = safeFloat(req.query['minUtility'], undefined, 0, 1);

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

      const limit = safeInt(req.query['limit'], 20, 500);
      const terms = search.split(/\s+/).filter((t) => t.length > 0);
      if (terms.length === 0) {
        res.status(400).json({ error: 'Search query must contain at least one non-empty term' });
        return;
      }
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

      const nameResult = requireString(name, 'name');
      if ('error' in nameResult) { res.status(400).json({ error: nameResult.error }); return; }
      const typeResult = requireString(entityType, 'entityType');
      if ('error' in typeResult) { res.status(400).json({ error: typeResult.error }); return; }

      if (aliases !== undefined && !Array.isArray(aliases)) {
        res.status(400).json({ error: 'aliases must be an array of strings' });
        return;
      }
      const safeAliases = Array.isArray(aliases)
        ? aliases.filter((a): a is string => typeof a === 'string')
        : [];

      const entity = await mempalaceRepository.upsertEntity({
        userId,
        name: nameResult.value,
        entityType: typeResult.value,
        properties: (properties && typeof properties === 'object' && !Array.isArray(properties))
          ? properties as Record<string, unknown>
          : {},
        aliases: safeAliases,
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
      const asOfRaw = safeDateParam(req.query['asOf']);
      if (typeof asOfRaw === 'string') {
        res.status(400).json({ error: `Invalid asOf: ${asOfRaw}` });
        return;
      }
      const asOf = asOfRaw;
      const limit = safeInt(req.query['limit'], 100, 1000);

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

      const subjectResult = requireString(subject, 'subject');
      if ('error' in subjectResult) { res.status(400).json({ error: subjectResult.error }); return; }
      const predicateResult = requireString(predicate, 'predicate');
      if ('error' in predicateResult) { res.status(400).json({ error: predicateResult.error }); return; }
      const objectResult = requireString(object, 'object');
      if ('error' in objectResult) { res.status(400).json({ error: objectResult.error }); return; }

      const resolvedConfidence = typeof confidence === 'string' ? confidence : 'moderate';
      if (!VALID_CONFIDENCE.has(resolvedConfidence)) {
        res.status(400).json({ error: `Invalid confidence. Must be one of: ${[...VALID_CONFIDENCE].join(', ')}` });
        return;
      }

      const validFromDate = safeDateParam(validFrom);
      if (typeof validFromDate === 'string') {
        res.status(400).json({ error: `Invalid validFrom: ${validFromDate}` });
        return;
      }

      const triple = await mempalaceRepository.addTriple({
        userId,
        subject: subjectResult.value,
        predicate: predicateResult.value,
        object: objectResult.value,
        confidence: resolvedConfidence,
        validFrom: validFromDate,
      });

      res.status(201).json({ triple });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
