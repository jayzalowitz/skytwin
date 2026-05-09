import { Router } from 'express';
import { createLogger } from '@skytwin/core';
import {
  getSettings as getBrainSettings,
  upsertSettings as upsertBrainSettings,
  countPages,
  pendingEmbeddingJobs,
} from '@skytwin/memory-gbrain-crdb-adapter';
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
        pendingEmbeddingJobs().catch(() => 0),
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

  return router;
}
