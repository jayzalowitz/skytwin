import { Router, type Request, type Response } from 'express';
import {
  MODEL_REGISTRY,
  checkForUpgrade,
  recommendDefault,
  type RamBracket,
} from '@skytwin/embedded-llm';
import { modelDownloadRepository, type ModelDownloadRow } from '@skytwin/db';
import {
  bindUserIdParamOwnership,
  requireOwnership,
} from '../middleware/require-ownership.js';
import {
  cancelDownload,
  pauseDownload,
  resolveModelDir,
  startDownload,
} from '../embedded-llm/downloader.js';

/**
 * Fetch a download row and enforce that the authenticated user owns
 * it. In dev-bypass mode (`req.authenticatedUserId === undefined`) the
 * ownership check is skipped, matching `requireOwnership`'s contract.
 *
 * Returns the row on success, or null if the response has already been
 * sent (404 / 403).
 */
async function loadOwnedDownload(
  req: Request,
  res: Response,
  id: string,
): Promise<ModelDownloadRow | null> {
  const row = await modelDownloadRepository.findById(id);
  if (!row) {
    res.status(404).json({ error: 'download not found' });
    return null;
  }
  const authUserId = req.authenticatedUserId;
  if (authUserId !== undefined && authUserId !== row.user_id) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have access to this resource.',
    });
    return null;
  }
  return row;
}

/**
 * Embedded LLM routes (#187 AC#2 + AC#5).
 *
 * Catalog (AC#5):
 *   GET  /api/embedded-llm/registry
 *   GET  /api/embedded-llm/upgrade-check?currentId=<id>
 *   GET  /api/embedded-llm/recommend-default?bracket=<bucket>
 *
 * Downloader (AC#2):
 *   GET  /api/embedded-llm/model-dir
 *     Reports the resolved model directory the API will write to —
 *     useful for "where's my model going?" debugging UX.
 *   POST /api/embedded-llm/downloads/start    body: { userId, modelId }
 *     Idempotent on (userId, modelId). Returns the row + `resumed` flag.
 *   GET  /api/embedded-llm/downloads/:id
 *     Polled by the UI every ~1s during active download.
 *   GET  /api/embedded-llm/downloads/user/:userId
 *     List for a user — surfaces "in progress" + "completed" history.
 *   POST /api/embedded-llm/downloads/:id/pause
 *   POST /api/embedded-llm/downloads/:id/resume
 *   POST /api/embedded-llm/downloads/:id/cancel
 */
export function createEmbeddedLlmRouter(): Router {
  const router = Router();
  bindUserIdParamOwnership(router);

  // ── Catalog (AC#5) ────────────────────────────────────────────

  router.get('/registry', (_req, res) => {
    res.json({ models: MODEL_REGISTRY });
  });

  router.get('/upgrade-check', (req, res) => {
    const currentId = req.query['currentId'];
    if (typeof currentId !== 'string' || currentId.length === 0) {
      res.status(400).json({ error: 'currentId query param required' });
      return;
    }
    const upgrade = checkForUpgrade(currentId);
    res.json({ upgrade });
  });

  router.get('/recommend-default', (req, res) => {
    const bracket = req.query['bracket'];
    const valid: ReadonlyArray<RamBracket> = ['4gb', '8gb', '16gb', '32gb-plus'];
    if (typeof bracket !== 'string' || !valid.includes(bracket as RamBracket)) {
      res.status(400).json({ error: 'bracket must be one of 4gb / 8gb / 16gb / 32gb-plus' });
      return;
    }
    const model = recommendDefault(bracket as RamBracket);
    res.json({ model });
  });

  // ── Downloader (AC#2) ─────────────────────────────────────────

  router.get('/model-dir', (_req, res) => {
    res.json({ modelDir: resolveModelDir() });
  });

  router.post('/downloads/start', requireOwnership, async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const userId = body['userId'];
      const modelId = body['modelId'];
      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      if (typeof modelId !== 'string' || modelId.length === 0) {
        res.status(400).json({ error: 'modelId required' });
        return;
      }
      try {
        const result = await startDownload(userId, modelId);
        res.json({
          download: rowToJson(result.download),
          resumed: result.resumed,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/^unknown model id/.test(msg)) {
          res.status(404).json({ error: msg });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  router.get('/downloads/user/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const rows = await modelDownloadRepository.listForUser(userId);
      res.json({ downloads: rows.map(rowToJson) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/downloads/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      const row = await loadOwnedDownload(req, res, id);
      if (!row) return;
      res.json({ download: rowToJson(row) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/downloads/:id/pause', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      const row = await loadOwnedDownload(req, res, id);
      if (!row) return;
      const ok = await pauseDownload(id);
      res.json({ ok });
    } catch (err) {
      next(err);
    }
  });

  router.post('/downloads/:id/resume', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      const row = await loadOwnedDownload(req, res, id);
      if (!row) return;
      // Resume re-runs `startDownload` for this row's (userId, modelId).
      // The function's idempotent-on-active-row behavior picks up the
      // existing row and continues from `bytes_downloaded`.
      const result = await startDownload(row.user_id, row.model_id);
      res.json({ download: rowToJson(result.download), resumed: result.resumed });
    } catch (err) {
      next(err);
    }
  });

  router.post('/downloads/:id/cancel', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      const row = await loadOwnedDownload(req, res, id);
      if (!row) return;
      const ok = await cancelDownload(id);
      res.json({ ok });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

interface DownloadJson {
  id: string;
  modelId: string;
  targetPath: string;
  totalBytes: number;
  bytesDownloaded: number;
  status: string;
  error: string | null;
  startedAt: string;
  pausedAt: string | null;
  completedAt: string | null;
  percent: number;
}

function rowToJson(r: import('@skytwin/db').ModelDownloadRow): DownloadJson {
  const totalBytes = Number(r.total_bytes);
  const bytesDownloaded = Number(r.bytes_downloaded);
  const percent = totalBytes > 0
    ? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100))
    : 0;
  return {
    id: r.id,
    modelId: r.model_id,
    targetPath: r.target_path,
    totalBytes,
    bytesDownloaded,
    status: r.status,
    error: r.error,
    startedAt: r.started_at.toISOString(),
    pausedAt: r.paused_at?.toISOString() ?? null,
    completedAt: r.completed_at?.toISOString() ?? null,
    percent,
  };
}
