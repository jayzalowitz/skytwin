/**
 * Scheduler / batch runner for `runRelationshipTierBackfillJob` (#282).
 *
 * The backfill was originally invoked inside the connector poll loop
 * via `await runRelationshipTierBackfillJob(uc.userId)` per user,
 * sequentially. Once a single user crosses ~100k pages or ~1M signals
 * in the 90d window, the per-user pass walks meaningful CPU and SQL
 * time — sequential iteration across all users could starve the
 * connector poll loop for minutes, delaying signal ingestion.
 *
 * This module wraps the per-user job with:
 *   - Bounded concurrency: at most `RELATIONSHIP_TIER_BACKFILL_CONCURRENCY`
 *     users in flight at once. A few in parallel keeps SQL load
 *     manageable; all-at-once would saturate the DB and the embedding
 *     provider.
 *   - Per-user timeout: a slow user (huge mailbox, hung SQL) does NOT
 *     block the queue indefinitely. After
 *     `RELATIONSHIP_TIER_BACKFILL_USER_TIMEOUT_MS` the in-flight job
 *     is abandoned and we move on; the next 24h cycle gets another
 *     attempt.
 *   - Error isolation: one user's failure (DB error, malformed page,
 *     etc.) does not propagate to the others.
 *
 * Callers fire-and-forget this from the poll loop with a single-flight
 * guard — see `apps/worker/src/index.ts`. The poll loop never awaits
 * the batch's promise so signal ingestion stays unblocked.
 */

import { createLogger } from '@skytwin/core';
import { runRelationshipTierBackfillJob } from './relationship-tier-backfill.js';

const log = createLogger('relationship-tier-scheduler');

/**
 * Maximum users processed in parallel. 3 keeps SQL + the embedding
 * provider's per-user concurrency budget bounded while still moving
 * faster than strictly-sequential. Bump cautiously: the per-user job
 * itself does multiple SQL roundtrips (counts, recent pages, per-page
 * metadata updates).
 */
export const RELATIONSHIP_TIER_BACKFILL_CONCURRENCY = 3;

/**
 * Per-user timeout. A pass on a fully-tagged mailbox is near-instant; a
 * cold-start pass on a heavy mailbox is bounded by the recent-pages
 * batch size (currently 500). 5 minutes is generous and well above the
 * 99p of measured passes — anything taking longer is almost certainly
 * stuck.
 */
export const RELATIONSHIP_TIER_BACKFILL_USER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Race a promise against a timeout. The timeout REJECTS with a
 * timeout error; the caller catches it. We don't actually abort the
 * underlying SQL — that requires AbortSignal plumbing that the
 * repository layer doesn't yet expose — but the timeout unblocks the
 * scheduler so the queue keeps moving. The orphaned SQL completes
 * eventually and its result is discarded.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run the relationship-tier backfill for every user in `userIds` with
 * bounded concurrency and per-user timeout. Resolves when every user
 * has either completed, errored, or timed out. Never rejects — all
 * errors are caught and logged. Returns a count of successful /
 * failed / timed-out users for telemetry.
 */
export async function runRelationshipTierBackfillBatch(
  userIds: readonly string[],
): Promise<{ succeeded: number; failed: number; timedOut: number }> {
  const summary = { succeeded: 0, failed: 0, timedOut: 0 };
  if (userIds.length === 0) return summary;

  for (let i = 0; i < userIds.length; i += RELATIONSHIP_TIER_BACKFILL_CONCURRENCY) {
    const slice = userIds.slice(i, i + RELATIONSHIP_TIER_BACKFILL_CONCURRENCY);
    await Promise.all(
      slice.map(async (userId) => {
        try {
          await withTimeout(
            runRelationshipTierBackfillJob(userId),
            RELATIONSHIP_TIER_BACKFILL_USER_TIMEOUT_MS,
            `relationship-tier backfill user=${userId}`,
          );
          summary.succeeded++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('timed out')) {
            summary.timedOut++;
            log.warn('relationship-tier backfill timed out for user', { userId, msg });
          } else {
            summary.failed++;
            log.warn('relationship-tier backfill failed for user', { userId, msg });
          }
        }
      }),
    );
  }
  return summary;
}
