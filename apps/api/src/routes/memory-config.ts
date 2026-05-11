import { Router } from 'express';
import { createLogger } from '@skytwin/core';
import {
  getSettings as getBrainSettings,
  upsertSettings as upsertBrainSettings,
  countPages,
  pendingEmbeddingJobs,
} from '@skytwin/memory-gbrain-crdb-adapter';
import { mempalaceRepository } from '@skytwin/db';
import {
  getMemoryPortForUser,
  setUserBackend,
  suggestHybridUpgrade,
  type BackendChoice,
} from '../memory-setup.js';

const log = createLogger('api:memory-config');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Routes for inspecting + configuring the memory backend (issue #197 AC #6/#7/#8).
 *
 *   GET  /api/memory-config?userId=…             — current backend + diagnostics
 *   POST /api/memory-config?userId=…             — set backend
 *        body: { backend: 'hybrid' | 'gbrain' | 'mempalace' }
 *   POST /api/memory-config/dismiss-notification — mark first-run notice seen
 *   GET  /api/memory-config/diagnostics?userId=… — counters for hybrid mode
 *
 * All routes are mounted under `requireOwnership` so userId-scoped enforcement
 * is handled at the middleware level. Cross-user reads are forbidden by the
 * middleware; this router does not double-check.
 */
export function createMemoryConfigRouter(): Router {
  const router = Router();

  // GET current configuration + a snapshot of the page index.
  router.get('/', async (req, res) => {
    const userId = String(req.query['userId'] ?? '');
    if (!UUID_REGEX.test(userId)) {
      return res.status(400).json({ error: 'invalid userId' });
    }
    try {
      const [settings, resolved, suggestion, counts, pendingJobs] = await Promise.all([
        getBrainSettings(userId).catch(() => null),
        getMemoryPortForUser(userId),
        Promise.resolve(suggestHybridUpgrade()),
        countPages(userId).catch(() => ({ total: 0, embedded: 0 })),
        // Per-user count — multi-tenant installs were getting the global queue depth.
        pendingEmbeddingJobs(userId).catch(() => 0),
      ]);

      const capabilitiesArr = [...resolved.port.capabilities()];
      return res.json({
        userId,
        backend: resolved.backend,
        capabilities: capabilitiesArr,
        hybridNotificationDismissed: settings?.hybrid_notification_dismissed ?? false,
        suggestion,
        index: {
          totalPages: counts.total,
          embeddedPages: counts.embedded,
          pendingEmbeddingJobs: pendingJobs,
        },
      });
    } catch (err) {
      log.error('memory-config GET failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'memory config unavailable' });
    }
  });

  // POST set backend choice.
  router.post('/', async (req, res) => {
    const userId = String(req.query['userId'] ?? '');
    if (!UUID_REGEX.test(userId)) {
      return res.status(400).json({ error: 'invalid userId' });
    }
    const body = (req.body ?? {}) as { backend?: unknown };
    const backend = body.backend;
    if (backend !== 'hybrid' && backend !== 'gbrain' && backend !== 'mempalace') {
      return res.status(400).json({ error: 'backend must be hybrid|gbrain|mempalace' });
    }
    try {
      await setUserBackend(userId, backend as BackendChoice);
      return res.json({ ok: true, backend });
    } catch (err) {
      log.error('memory-config POST failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'failed to update backend' });
    }
  });

  // POST dismiss the "your twin got smarter" notification.
  router.post('/dismiss-notification', async (req, res) => {
    const userId = String(req.query['userId'] ?? '');
    if (!UUID_REGEX.test(userId)) {
      return res.status(400).json({ error: 'invalid userId' });
    }
    try {
      await upsertBrainSettings(userId, { hybrid_notification_dismissed: true });
      return res.json({ ok: true });
    } catch (err) {
      log.error('dismiss-notification failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'failed to dismiss' });
    }
  });

  // GET diagnostics — only meaningful when backend is 'hybrid'.
  router.get('/diagnostics', async (req, res) => {
    const userId = String(req.query['userId'] ?? '');
    if (!UUID_REGEX.test(userId)) {
      return res.status(400).json({ error: 'invalid userId' });
    }
    try {
      const resolved = await getMemoryPortForUser(userId);
      if (!resolved.hybrid) {
        return res.json({
          backend: resolved.backend,
          diagnostics: null,
          note: 'hybrid mode not active; diagnostics only available in hybrid mode',
        });
      }
      return res.json({
        backend: 'hybrid',
        diagnostics: resolved.hybrid.getDiagnostics(),
      });
    } catch (err) {
      log.error('diagnostics failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'diagnostics unavailable' });
    }
  });

  /**
   * GET /api/memory-config/dashboard — operator + user-facing view of what
   * the twin actually remembers right now. Reads from the legacy
   * `episodic_memories` + `knowledge_entities` tables (which all backends
   * write through). Useful as evidence that the memory layer is doing
   * something, both for debugging and for the dashboard UI.
   */
  router.get('/dashboard', async (req, res) => {
    const userId = String(req.query['userId'] ?? '');
    if (!UUID_REGEX.test(userId)) {
      return res.status(400).json({ error: 'invalid userId' });
    }
    try {
      const [counts, pendingJobs, recentEpisodes, entities] = await Promise.all([
        countPages(userId).catch(() => ({ total: 0, embedded: 0 })),
        // Per-user count — multi-tenant installs were getting the global queue depth.
        pendingEmbeddingJobs(userId).catch(() => 0),
        mempalaceRepository.getEpisodes(userId, { limit: 10 }).catch(() => []),
        mempalaceRepository.getEntities(userId).catch(() => []),
      ]);

      // Compute feedback trend across the recent episode window.
      const feedbackCounts: Record<string, number> = {};
      for (const ep of recentEpisodes) {
        const ft = (ep.feedback_type as string | null) ?? 'no_feedback';
        feedbackCounts[ft] = (feedbackCounts[ft] ?? 0) + 1;
      }

      // Entity histogram by type (top 5).
      const entityByType: Record<string, number> = {};
      for (const e of entities) {
        const t = e.entity_type as string;
        entityByType[t] = (entityByType[t] ?? 0) + 1;
      }
      const topEntityTypes = Object.entries(entityByType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, count]) => ({ type, count }));

      // Top 10 entities by recency (lastSeenAt desc).
      const topEntities = entities
        .slice()
        .sort((a, b) => {
          const at = a.updated_at instanceof Date ? a.updated_at.getTime() : new Date(a.updated_at as unknown as string).getTime();
          const bt = b.updated_at instanceof Date ? b.updated_at.getTime() : new Date(b.updated_at as unknown as string).getTime();
          return bt - at;
        })
        .slice(0, 10)
        .map((e) => ({
          id: e.id,
          name: e.name,
          entityType: e.entity_type,
          lastSeenAt: e.updated_at,
        }));

      const formattedEpisodes = recentEpisodes.map((ep) => ({
        id: ep.id,
        summary: ep.situation_summary,
        domain: ep.domain,
        situationType: ep.situation_type,
        actionTaken: ep.action_taken,
        feedbackType: ep.feedback_type,
        utilityScore: typeof ep.utility_score === 'number' ? ep.utility_score : Number(ep.utility_score),
        createdAt: ep.created_at,
      }));

      return res.json({
        userId,
        index: {
          totalPages: counts.total,
          embeddedPages: counts.embedded,
          pendingEmbeddingJobs: pendingJobs,
        },
        episodes: {
          recent: formattedEpisodes,
          feedbackCounts,
        },
        entities: {
          total: entities.length,
          topByRecency: topEntities,
          topByType: topEntityTypes,
        },
      });
    } catch (err) {
      log.error('dashboard failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'dashboard unavailable' });
    }
  });

  return router;
}
