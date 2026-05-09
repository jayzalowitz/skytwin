import { Router } from 'express';
import { recoveryCodeRepository, vacationModeRepository } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

const log = createLogger('api:crisis-modes');

const VACATION_MAX_DAYS = 90;

/**
 * Crisis modes (#194 Child 3 partial — recovery codes + vacation).
 *
 *   GET    /api/crisis-modes/:userId/recovery-codes
 *   POST   /api/crisis-modes/:userId/recovery-codes/regenerate
 *   POST   /api/crisis-modes/:userId/recovery-codes/redeem
 *   GET    /api/crisis-modes/:userId/vacation
 *   POST   /api/crisis-modes/:userId/vacation/start    body: { days } or { until }
 *   POST   /api/crisis-modes/:userId/vacation/end
 *
 * Out of scope here: emergency access (trusted contact + 2FA) and
 * incapacitated mode (no-activity detection). Those need email +
 * push-notification infrastructure that doesn't exist yet.
 */
export function createCrisisModesRouter(): Router {
  const router = Router();
  bindUserIdParamOwnership(router);

  // ── Recovery codes ─────────────────────────────────────────────

  router.get('/:userId/recovery-codes', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const [unusedCount, all] = await Promise.all([
        recoveryCodeRepository.countUnused(userId),
        recoveryCodeRepository.listForUser(userId),
      ]);
      res.json({
        unusedCount,
        codes: all.map((c) => ({
          id: c.id,
          createdAt: c.createdAt.toISOString(),
          usedAt: c.usedAt?.toISOString() ?? null,
          usedFor: c.usedFor,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:userId/recovery-codes/regenerate', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const codes = await recoveryCodeRepository.generateForUser(userId, 10);
      log.info('Recovery codes regenerated', { userId, count: codes.length });
      // Plaintext returned exactly once. The client MUST display them
      // and prompt the user to write them down before navigating away.
      res.json({ codes });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:userId/recovery-codes/redeem', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const code = (req.body as { code?: unknown })?.code;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      if (typeof code !== 'string' || code.length === 0) {
        res.status(400).json({ error: 'code required' });
        return;
      }
      const result = await recoveryCodeRepository.redeem(userId, code, 'vault-unlock');
      if (!result.ok) {
        // Don't distinguish "wrong code" from "already used" so an
        // attacker can't probe redemption state.
        log.warn('Recovery code redemption failed', { userId });
        res.status(401).json({ error: 'invalid or already-used code' });
        return;
      }
      log.info('Recovery code redeemed', { userId, codeId: result.codeId });
      res.json({ ok: true, codeId: result.codeId });
    } catch (err) {
      next(err);
    }
  });

  // ── Vacation mode ──────────────────────────────────────────────

  router.get('/:userId/vacation', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const status = await vacationModeRepository.get(userId);
      res.json({
        active: status.active,
        until: status.until?.toISOString() ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:userId/vacation/start', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const body = req.body as Record<string, unknown>;
      let until: Date;
      if (typeof body['days'] === 'number') {
        const days = body['days'];
        if (!Number.isFinite(days) || days <= 0 || days > VACATION_MAX_DAYS) {
          res.status(400).json({ error: `days must be 1..${VACATION_MAX_DAYS}` });
          return;
        }
        until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      } else if (typeof body['until'] === 'string') {
        const parsed = Date.parse(body['until']);
        if (!Number.isFinite(parsed)) {
          res.status(400).json({ error: 'until must be an ISO 8601 date' });
          return;
        }
        until = new Date(parsed);
        if (until.getTime() <= Date.now()) {
          res.status(400).json({ error: 'until must be in the future' });
          return;
        }
        const maxMs = VACATION_MAX_DAYS * 24 * 60 * 60 * 1000;
        if (until.getTime() - Date.now() > maxMs) {
          res.status(400).json({ error: `until must be within ${VACATION_MAX_DAYS} days` });
          return;
        }
      } else {
        res.status(400).json({ error: 'provide days (1..90) or until (ISO 8601)' });
        return;
      }
      await vacationModeRepository.set(userId, until);
      log.info('Vacation mode started', { userId, until: until.toISOString() });
      res.json({ active: true, until: until.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:userId/vacation/end', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      await vacationModeRepository.set(userId, null);
      log.info('Vacation mode ended', { userId });
      res.json({ active: false, until: null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
