import { Router } from 'express';
import { createLogger } from '@skytwin/core';
import {
  workerDeadLetterRepository,
  type WorkerDeadLetterRow,
  type WorkerDeadLetterStatus,
} from '@skytwin/db';

/**
 * Operator-facing dead-letter-queue admin surface (#407, parent #357).
 *
 * The worker routes a background job to `worker_dead_letter` after it
 * exceeds its retry budget (see apps/worker/src/dead-letter.ts). This
 * router lets the operator inspect that queue and resolve each row —
 * either `replayed` (re-queue the job by clearing the retry streak and
 * letting the next worker cycle pick it up) or `discarded` (dismiss it).
 *
 * SkyTwin is single-owner: there is no separate admin role, so the
 * session-authenticated owner IS the operator. Mounted under
 * `sessionAuth` only (no `requireOwnership` — these rows are
 * process-global, not user-scoped).
 *
 * NOTE on "replay": the worker's jobs are cadence-driven and idempotent
 * (embedding backfill drains a SELECT FOR UPDATE SKIP LOCKED queue,
 * domain extraction / briefings re-read live state, promotion-eligibility
 * is ON CONFLICT-guarded). Marking a row `replayed` therefore does NOT
 * re-execute the job synchronously — it records the operator's intent and
 * clears the row from the actionable queue. The job re-runs on its normal
 * cadence (now that the underlying cause is presumably fixed). A future
 * follow-up could add a worker IPC channel to force an immediate re-run;
 * for v1 the cadence is the replay mechanism and this endpoint is the
 * acknowledgement.
 */

const log = createLogger('api:admin-dlq');

const VALID_RESOLUTIONS: ReadonlySet<string> = new Set(['replayed', 'discarded']);

interface DeadLetterDTO {
  id: string;
  jobName: string;
  errorMessage: string;
  attempts: number;
  context: unknown;
  status: WorkerDeadLetterStatus;
  deadLetteredAt: string;
  resolvedAt: string | null;
}

function rowToDTO(row: WorkerDeadLetterRow): DeadLetterDTO {
  return {
    id: row.id,
    jobName: row.job_name,
    errorMessage: row.error_message,
    attempts: row.attempts,
    context: row.context,
    status: row.status,
    deadLetteredAt: row.dead_lettered_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

export function createAdminDlqRouter(): Router {
  const router = Router();

  /**
   * GET /api/admin/dead-letter
   *
   * Query params (all optional):
   *   status  — 'pending' (default) | 'replayed' | 'discarded' | 'all'
   *   jobName — narrow to a single job
   *   limit   — page size (default 100, capped at 500 by the repo)
   *
   * Returns the rows plus a `pendingCount` badge so the dashboard can
   * render the queue size without a second round-trip.
   */
  router.get('/dead-letter', async (req, res, next) => {
    try {
      const rawStatus = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
      const jobName = typeof req.query['jobName'] === 'string' ? req.query['jobName'] : undefined;
      const rawLimit = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : undefined;

      // Map the public query value to the repository's `status` option.
      // 'all' → null (include resolved history); a specific status passes
      // through; anything else (including omitted) → 'pending'.
      let status: WorkerDeadLetterStatus | null;
      if (rawStatus === 'all') {
        status = null;
      } else if (
        rawStatus === 'pending' ||
        rawStatus === 'replayed' ||
        rawStatus === 'discarded'
      ) {
        status = rawStatus;
      } else {
        status = 'pending';
      }

      const limit = rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : undefined;

      const rows = await workerDeadLetterRepository.list({
        status,
        ...(jobName ? { jobName } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      const pendingCount = await workerDeadLetterRepository.countPending();

      res.json({ deadLetters: rows.map(rowToDTO), pendingCount });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/admin/dead-letter/:id/resolve
   *
   * Body: { resolution: 'replayed' | 'discarded' }
   *
   * Transitions a still-pending row to the given resolution. Race-safe
   * in the repository (only `pending` rows transition), so a 409 means
   * the row was already resolved by a concurrent request.
   */
  router.post('/dead-letter/:id/resolve', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { resolution } = (req.body ?? {}) as { resolution?: string };
      if (!id) {
        res.status(400).json({ error: 'Missing id parameter' });
        return;
      }
      if (!resolution || !VALID_RESOLUTIONS.has(resolution)) {
        res.status(400).json({
          error: `Invalid resolution. Expected one of: ${Array.from(VALID_RESOLUTIONS).join(', ')}`,
        });
        return;
      }

      const updated = await workerDeadLetterRepository.markResolved(
        id,
        resolution as 'replayed' | 'discarded',
      );
      if (!updated) {
        // Either the row doesn't exist or it was already resolved.
        // Distinguish so the operator gets an accurate message.
        const existing = await workerDeadLetterRepository.findById(id);
        if (!existing) {
          res.status(404).json({ error: 'Dead-letter row not found' });
          return;
        }
        res.status(409).json({
          error: 'Dead-letter row already resolved',
          status: existing.status,
        });
        return;
      }

      log.info('Dead-letter row resolved', {
        id,
        jobName: updated.job_name,
        resolution,
      });
      res.json({ ok: true, deadLetter: rowToDTO(updated) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
