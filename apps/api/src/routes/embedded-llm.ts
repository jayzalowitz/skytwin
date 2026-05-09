import { Router } from 'express';
import {
  MODEL_REGISTRY,
  checkForUpgrade,
  recommendDefault,
  type RamBracket,
} from '@skytwin/embedded-llm';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

/**
 * Embedded LLM model registry routes (#187 AC#5).
 *
 *   GET  /api/embedded-llm/registry
 *     Returns the curated model list grouped by RAM bracket.
 *
 *   GET  /api/embedded-llm/upgrade-check?currentId=<id>
 *     Returns `{ upgrade: UpgradeRecommendation | null }`. Clients call
 *     this on app start to decide whether to surface the "your twin can
 *     be N% smarter" prompt.
 *
 *   GET  /api/embedded-llm/recommend-default?bracket=<4gb|8gb|16gb|32gb-plus>
 *     Returns the highest-quality model in the bracket — used by the
 *     first-run flow.
 *
 * The registry itself is a static, hand-curated list shipped with the
 * `@skytwin/embedded-llm` package. No external HTTP. The downloader UI
 * (#187 AC#2) consumes the `downloadUrl` field; this API just exposes
 * the catalog.
 */
export function createEmbeddedLlmRouter(): Router {
  const router = Router();
  bindUserIdParamOwnership(router);

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

  return router;
}
