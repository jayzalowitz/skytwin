import { Router } from 'express';
import { parseRoutineSpec } from '@skytwin/routines';
import type { RoutineSpec, RoutineStatus } from '@skytwin/shared-types';
import { watchRepository } from '@skytwin/db';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

/**
 * `/api/watches` — no-code routines (#519 part 2). A Watch is a READ-ONLY
 * signal watcher (digest / notify on a schedule). It executes no action, so
 * there is no policy gate here — that is the whole safety point of read-only v1.
 * Deliberately separate from the IronClaw cron `/api/routines` execution path.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const CADENCES = new Set(['hourly', 'daily', 'weekly']);
const ACTIONS = new Set(['digest', 'notify']);

/** Validate + normalize a caller-supplied spec into a clean `RoutineSpec`. */
function validateSpec(
  spec: unknown,
): { ok: true; spec: RoutineSpec } | { ok: false; error: string } {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, error: 'spec must be an object' };
  }
  const s = spec as Record<string, unknown>;
  if (typeof s['name'] !== 'string' || !s['name'].trim()) {
    return { ok: false, error: 'spec.name is required' };
  }
  if (typeof s['cadence'] !== 'string' || !CADENCES.has(s['cadence'])) {
    return { ok: false, error: 'spec.cadence must be hourly | daily | weekly' };
  }
  if (typeof s['action'] !== 'string' || !ACTIONS.has(s['action'])) {
    return { ok: false, error: 'spec.action must be digest | notify' };
  }
  const filter = s['filter'];
  if (filter !== undefined && (typeof filter !== 'object' || filter === null || Array.isArray(filter))) {
    return { ok: false, error: 'spec.filter must be an object' };
  }
  const hod = s['hourOfDay'];
  if (hod !== undefined && (typeof hod !== 'number' || !Number.isInteger(hod) || hod < 0 || hod > 23)) {
    return { ok: false, error: 'spec.hourOfDay must be an integer 0-23' };
  }
  const dow = s['dayOfWeek'];
  if (dow !== undefined && (typeof dow !== 'number' || !Number.isInteger(dow) || dow < 0 || dow > 6)) {
    return { ok: false, error: 'spec.dayOfWeek must be an integer 0-6' };
  }
  const clean: RoutineSpec = {
    name: (s['name'] as string).trim().slice(0, 120),
    cadence: s['cadence'] as RoutineSpec['cadence'],
    action: s['action'] as RoutineSpec['action'],
    filter: (filter as RoutineSpec['filter']) ?? {},
    ...(typeof hod === 'number' ? { hourOfDay: hod } : {}),
    ...(typeof dow === 'number' ? { dayOfWeek: dow } : {}),
  };
  return { ok: true, spec: clean };
}

export function createWatchesRouter(): Router {
  const router = Router();

  // POST /parse — preview a natural-language ask as a RoutineSpec. Pure,
  // read-only, no persistence. Param helpers below only gate `:userId` routes,
  // so this endpoint is gated solely by the mount-level session auth.
  router.post('/parse', (req, res) => {
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Missing required field: text' });
      return;
    }
    res.json(parseRoutineSpec(text.slice(0, MAX_TEXT)));
  });

  // Validate + enforce ownership on any `:userId` route below.
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);

  // POST /:userId — create a watch from natural language {text} OR a confirmed
  // structured {spec, sourceText}.
  router.post('/:userId', async (req, res, next) => {
    try {
      const userId = req.params['userId']!;
      const body = (req.body ?? {}) as {
        text?: unknown;
        spec?: unknown;
        sourceText?: unknown;
        status?: unknown;
      };

      let spec: RoutineSpec;
      let sourceText: string;
      if (typeof body.text === 'string' && body.text.trim()) {
        const parsed = parseRoutineSpec(body.text.slice(0, MAX_TEXT));
        if (!parsed.matched) {
          res.status(400).json({ error: "That doesn't look like a routine.", reason: parsed.reason });
          return;
        }
        spec = parsed.spec;
        sourceText = body.text.slice(0, MAX_TEXT);
      } else if (body.spec !== undefined) {
        const v = validateSpec(body.spec);
        if (!v.ok) {
          res.status(400).json({ error: v.error });
          return;
        }
        spec = v.spec;
        sourceText =
          typeof body.sourceText === 'string' ? body.sourceText.slice(0, MAX_TEXT) : spec.name;
      } else {
        res.status(400).json({ error: 'Provide either `text` (natural language) or `spec`.' });
        return;
      }

      const status: RoutineStatus = body.status === 'draft' ? 'draft' : 'active';
      const watch = await watchRepository.create({
        userId,
        sourceText,
        spec,
        status,
        // An active watch is due immediately; the scheduler (a later part)
        // recomputes next_run_at after each firing.
        nextRunAt: status === 'active' ? new Date() : null,
      });
      res.status(201).json(watch);
    } catch (err) {
      next(err);
    }
  });

  // GET /:userId — list the user's watches.
  router.get('/:userId', async (req, res, next) => {
    try {
      const watches = await watchRepository.listForUser(req.params['userId']!);
      res.json({ watches });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /:userId/:watchId — pause/resume ({status}) or edit ({spec}).
  router.patch('/:userId/:watchId', async (req, res, next) => {
    try {
      const userId = req.params['userId']!;
      const watchId = req.params['watchId']!;
      if (!UUID_RE.test(watchId)) {
        res.status(400).json({ error: 'Invalid watchId.' });
        return;
      }
      const body = (req.body ?? {}) as { status?: unknown; spec?: unknown };

      if (body.status !== undefined) {
        if (body.status !== 'active' && body.status !== 'paused' && body.status !== 'draft') {
          res.status(400).json({ error: 'status must be active | paused | draft' });
          return;
        }
        const updated = await watchRepository.setStatus(
          watchId,
          userId,
          body.status,
          body.status === 'active' ? new Date() : null,
        );
        if (!updated) {
          res.status(404).json({ error: 'Watch not found.' });
          return;
        }
        res.json(updated);
        return;
      }

      if (body.spec !== undefined) {
        const v = validateSpec(body.spec);
        if (!v.ok) {
          res.status(400).json({ error: v.error });
          return;
        }
        const updated = await watchRepository.updateSpec(watchId, userId, v.spec);
        if (!updated) {
          res.status(404).json({ error: 'Watch not found.' });
          return;
        }
        res.json(updated);
        return;
      }

      res.status(400).json({ error: 'Provide `status` or `spec` to update.' });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /:userId/:watchId
  router.delete('/:userId/:watchId', async (req, res, next) => {
    try {
      const watchId = req.params['watchId']!;
      if (!UUID_RE.test(watchId)) {
        res.status(400).json({ error: 'Invalid watchId.' });
        return;
      }
      const ok = await watchRepository.delete(watchId, req.params['userId']!);
      if (!ok) {
        res.status(404).json({ error: 'Watch not found.' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
