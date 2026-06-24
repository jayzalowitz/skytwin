import { Router } from 'express';
import { createLogger } from '@skytwin/core';
import { getMemoryPortForUser } from '../memory-setup.js';
import { UUID_REGEX } from '../middleware/validate-uuid.js';

const log = createLogger('api:search');

/**
 * Instant memory search. The semantic retrieval engine (vector + tsvector
 * RRF via `MemoryPort.searchSemantic`) already powers the assistant's
 * context enrichment, but until now it was reachable ONLY through a chat
 * turn — there was no way to just *search* your own memory. This route
 * exposes it directly so the web dashboard (and any client) can run an
 * instant lookup across emails, calendar, and what the twin has learned.
 *
 * GET /api/search?userId=<uuid>&q=<text>&limit=<n>
 *   → { query, results: [{ id, snippet, source, domain, score }], degraded? }
 *
 * Mounted under sessionAuth + requireOwnership in apps/api/src/index.ts, so
 * `?userId=` is gated to the authenticated user — a client cannot search
 * another user's memory.
 */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_QUERY_LEN = 512;
const SNIPPET_MAX = 240;

/**
 * Collapse a raw record body (gbrain stores multi-line email / web / file
 * content) into a single clean snippet line, capped for display + payload
 * size. Mirrors the assistant's source-label normalization.
 */
function toSnippet(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > SNIPPET_MAX ? `${oneLine.slice(0, SNIPPET_MAX - 1)}…` : oneLine;
}

export function createSearchRouter(): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const userId = req.query['userId'];
      if (typeof userId !== 'string' || !UUID_REGEX.test(userId)) {
        res.status(400).json({ error: 'userId query param is required and must be a UUID' });
        return;
      }

      const rawQuery = req.query['q'];
      const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
      // Empty query is not an error — the UI calls this as the user types and
      // clears the box. Return an empty result set so the client renders its
      // resting state without a 400.
      if (query.length === 0) {
        res.json({ query: '', results: [] });
        return;
      }
      if (query.length > MAX_QUERY_LEN) {
        res.status(413).json({ error: `q must be <= ${MAX_QUERY_LEN} characters` });
        return;
      }

      const limitParsed = Number.parseInt(String(req.query['limit'] ?? ''), 10);
      const limit = Number.isFinite(limitParsed)
        ? Math.min(Math.max(limitParsed, 1), MAX_LIMIT)
        : DEFAULT_LIMIT;

      // Soft-fail: search is a non-critical, read-only surface. An embedding
      // outage or empty index should render "no matches", not a 500.
      let hits;
      try {
        const { port } = await getMemoryPortForUser(userId);
        hits = await port.searchSemantic(query, limit);
      } catch (err) {
        log.warn('searchSemantic failed, returning empty result set', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.json({ query, results: [], degraded: true });
        return;
      }

      const results = hits
        .map((h) => {
          const meta = (h.metadata ?? {}) as Record<string, unknown>;
          const domain = typeof meta['domain'] === 'string' ? (meta['domain'] as string) : undefined;
          return {
            id: h.id,
            snippet: toSnippet(typeof h.content === 'string' ? h.content : ''),
            // Prefer the backend's origin label; fall back to the metadata
            // domain so a chip never renders blank.
            source:
              typeof h.source === 'string' && h.source.length > 0
                ? h.source
                : domain ?? 'memory',
            ...(domain ? { domain } : {}),
            ...(typeof h.score === 'number' ? { score: h.score } : {}),
          };
        })
        .filter((r) => r.snippet.length > 0);

      res.json({ query, results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
