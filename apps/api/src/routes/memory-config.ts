import { Router } from 'express';
import { createLogger } from '@skytwin/core';
import {
  getSettings as getBrainSettings,
  upsertSettings as upsertBrainSettings,
  countPages,
  countUserSentPages,
  getRecentPages,
  pendingEmbeddingJobs,
  calibrationFromSentVolume,
  updatePageMetadata,
  hideAllPagesFromSender,
  type TierCalibration,
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
        // #251 Layer 2: surface tier-weighting toggle + calibration band so
        // the dashboard can show + flip them. Falls back to defaults when
        // the brain_settings row is missing (fresh user).
        tierWeighting: settings?.tier_weighting ?? false,
        tierCalibration: settings?.tier_calibration ?? 'normal',
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

  // POST toggle tier_weighting (#251 Layer 2). On enable, recompute the
  // calibration band from the user's current `user_sent_*` page count over
  // the last 90 days so a sparse-writer doesn't get the wide-spread weights.
  // Body: `{ enabled: boolean, calibration?: 'sparse' | 'normal' | 'dense' }`.
  // An explicit `calibration` override skips the auto-recompute and is the
  // escape hatch for users who want to pin the band themselves.
  router.post('/tier-weighting', async (req, res) => {
    const userId = String(req.query['userId'] ?? '');
    if (!UUID_REGEX.test(userId)) {
      return res.status(400).json({ error: 'invalid userId' });
    }
    const body = (req.body ?? {}) as {
      enabled?: unknown;
      calibration?: unknown;
    };
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (bool) is required' });
    }

    let calibration: TierCalibration | null = null;
    if (
      body.calibration === 'sparse' ||
      body.calibration === 'normal' ||
      body.calibration === 'dense'
    ) {
      calibration = body.calibration;
    } else if (body.enabled) {
      // Auto-compute from the user's writing volume. Worst case (transient
      // DB error) we fall back to 'normal'.
      try {
        const sentVolume = await countUserSentPages(userId, 90);
        calibration = calibrationFromSentVolume(sentVolume);
      } catch (err) {
        log.warn('tier_calibration auto-recompute failed; using normal', {
          userId,
          reason: err instanceof Error ? err.name : 'unknown',
        });
        calibration = 'normal';
      }
    }

    try {
      const next = await upsertBrainSettings(userId, {
        tier_weighting: body.enabled,
        ...(calibration ? { tier_calibration: calibration } : {}),
      });
      return res.json({
        ok: true,
        tierWeighting: next.tier_weighting,
        tierCalibration: next.tier_calibration,
      });
    } catch (err) {
      log.error('tier-weighting POST failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'failed to update tier weighting' });
    }
  });

  // POST per-page userOverride (#251 privacy follow-up).
  //
  // Body: `{ override: 'pinned' | 'hidden' | null }`. `null` clears the
  // override (no-op if there wasn't one). The :pageId param is matched
  // against `brain_pages.id`; the row's `user_id` column is checked
  // against the query-string userId so a guessable page id can't be
  // used to mutate another user's pages.
  //
  // 404 when the page doesn't exist or belongs to a different user —
  // we don't distinguish the two so a caller can't probe for foreign
  // page-id existence.
  router.post('/pages/:pageId/override', async (req, res) => {
    const userId = String(req.query['userId'] ?? '');
    if (!UUID_REGEX.test(userId)) {
      return res.status(400).json({ error: 'invalid userId' });
    }
    const pageId = String(req.params['pageId'] ?? '');
    if (!pageId) {
      return res.status(400).json({ error: 'missing pageId' });
    }
    const body = (req.body ?? {}) as { override?: unknown };
    if (
      body.override !== 'pinned' &&
      body.override !== 'hidden' &&
      body.override !== null
    ) {
      return res.status(400).json({
        error: "override must be 'pinned', 'hidden', or null",
      });
    }
    try {
      // `updatePageMetadata` treats null-valued patch keys as delete
      // requests (uses `jsonb - 'key'` in SQL, `delete` in the in-memory
      // mirror) so a `clear` action leaves the column clean rather than
      // storing `{"userOverride": null}` indefinitely.
      const patch =
        body.override === null
          ? { userOverride: null }
          : { userOverride: body.override };
      const affected = await updatePageMetadata(userId, pageId, patch);
      if (affected === 0) {
        return res.status(404).json({ error: 'page not found' });
      }
      return res.json({ ok: true, pageId, override: body.override });
    } catch (err) {
      log.error('pages override POST failed', {
        userId,
        pageId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'failed to update page override' });
    }
  });

  // POST per-sender bulk hide (#251 privacy follow-up). Body:
  // `{ fromAddress: string }`. Sets `metadata.userOverride='hidden'`
  // on every brain_page where `metadata.fromAddress` equals (case-
  // insensitively) the supplied address. The connector lower-cases at
  // write time so the query is exact-match.
  router.post('/senders/hide', async (req, res) => {
    const userId = String(req.query['userId'] ?? '');
    if (!UUID_REGEX.test(userId)) {
      return res.status(400).json({ error: 'invalid userId' });
    }
    const body = (req.body ?? {}) as { fromAddress?: unknown };
    if (typeof body.fromAddress !== 'string' || body.fromAddress.trim().length === 0) {
      return res.status(400).json({ error: 'fromAddress (string) is required' });
    }
    // Normalize once at the boundary — trim AND lower-case — so the
    // adapter query, the response, and any logged context all see the
    // same canonical form. Without the trim, "  spam@x.com  " would
    // pass validation but never match the stored fromAddress field
    // (which is trimmed + lower-cased at write time).
    const normalizedFrom = body.fromAddress.trim().toLowerCase();
    try {
      const hidden = await hideAllPagesFromSender(userId, normalizedFrom);
      return res.json({ ok: true, fromAddress: normalizedFrom, hidden });
    } catch (err) {
      log.error('senders hide POST failed', {
        userId,
        fromAddress: normalizedFrom,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'failed to hide sender' });
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
      const [counts, pendingJobs, recentEpisodes, entities, recentPages] = await Promise.all([
        countPages(userId).catch(() => ({ total: 0, embedded: 0 })),
        // Per-user count — multi-tenant installs were getting the global queue depth.
        pendingEmbeddingJobs(userId).catch(() => 0),
        mempalaceRepository.getEpisodes(userId, { limit: 10 }).catch(() => []),
        mempalaceRepository.getEntities(userId).catch(() => []),
        // #251 Layer 1 surfaces — recent indexed pages, with the authoring
        // tier badge from metadata. Empty array on failure so the rest of
        // the dashboard still renders.
        getRecentPages(userId, 10).catch(() => []),
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

      // Sanitize recent pages for the wire — strip the embedding vector
      // (large, irrelevant for UI) and surface only the fields the dashboard
      // actually renders. Tier comes from metadata.authoringTier;
      // fromAddress is what the per-sender bulk-hide UI sends back.
      const formattedPages = recentPages.map((p) => {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        const tier = typeof meta['authoringTier'] === 'string' ? (meta['authoringTier'] as string) : null;
        const userOverride = typeof meta['userOverride'] === 'string' ? (meta['userOverride'] as string) : null;
        const fromAddress = typeof meta['fromAddress'] === 'string' ? (meta['fromAddress'] as string) : null;
        return {
          id: p.id,
          title: p.title,
          source: p.source,
          createdAt: p.created_at,
          authoringTier: tier,
          userOverride,
          fromAddress,
        };
      });

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
        pages: {
          recent: formattedPages,
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
