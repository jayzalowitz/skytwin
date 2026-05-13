import { createLogger } from '@skytwin/core';
import {
  computeBidirectionalThreadCounts,
  relationshipTierFromThreadCount,
  updatePageMetadata,
  getRecentPages,
  type RelationshipTier,
} from '@skytwin/memory-gbrain-crdb-adapter';

const log = createLogger('relationship-tier-backfill');

/**
 * Populate `metadata.relationshipTier` on brain_pages based on
 * bidirectional thread counts over the last 90 days (#251 Phase 2).
 *
 * Per pass:
 *   1. Compute the contact → bidirectionalDays map for the user.
 *   2. Iterate the user's recent pages.
 *   3. For each page with a `metadata.fromAddress`, look up the count
 *      and derive the tier band (core/frequent/occasional/stranger).
 *   4. If the tier differs from what's already on the page (or is
 *      missing), update via `updatePageMetadata`.
 *
 * Idempotent — re-running on a fully-tagged corpus updates nothing.
 *
 * The relationship band is a function of the LAST 90 DAYS of activity,
 * so it can shift over time as the user's relationship density changes
 * with each contact. The worker runs daily; tiers converge to current
 * truth within a single pass.
 */
export interface RelationshipTierBackfillOptions {
  /** Maximum pages to consider per pass per user. Default 500. */
  batchSize?: number;
  /** Window for bidirectional-thread counting. Default 90 days. */
  windowDays?: number;
}

export interface RelationshipTierBackfillSummary {
  attempted: number;
  /** Tier added/changed → `updatePageMetadata` returned 1. */
  updated: number;
  /** Tier matched what was already on the page → no write. */
  unchanged: number;
  /** Page had no `metadata.fromAddress` → can't look up a tier. */
  skipped: number;
  /** `updatePageMetadata` threw or returned 0. */
  failed: number;
}

/**
 * Run a single relationship-tier backfill pass for a given user.
 */
export async function runRelationshipTierBackfillJob(
  userId: string,
  opts: RelationshipTierBackfillOptions = {},
): Promise<RelationshipTierBackfillSummary> {
  const batchSize = opts.batchSize ?? 500;
  const windowDays = opts.windowDays ?? 90;

  const summary: RelationshipTierBackfillSummary = {
    attempted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  };

  let counts: Map<string, number>;
  try {
    counts = await computeBidirectionalThreadCounts(userId, windowDays);
  } catch (err) {
    log.warn('computeBidirectionalThreadCounts failed; skipping user', {
      userId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return summary;
  }

  let pages: Array<{
    id: string;
    metadata: unknown;
  }>;
  try {
    const recent = await getRecentPages(userId, batchSize);
    pages = recent.map((p) => ({ id: p.id, metadata: p.metadata }));
  } catch (err) {
    log.warn('getRecentPages failed; skipping user', {
      userId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return summary;
  }

  for (const page of pages) {
    summary.attempted++;
    const meta = (page.metadata ?? {}) as Record<string, unknown>;
    const contact =
      typeof meta['fromAddress'] === 'string'
        ? (meta['fromAddress'] as string).toLowerCase()
        : null;
    if (!contact) {
      summary.skipped++;
      continue;
    }
    const count = counts.get(contact) ?? 0;
    const tier: RelationshipTier = relationshipTierFromThreadCount(count);
    const existing = meta['relationshipTier'];
    if (existing === tier) {
      summary.unchanged++;
      continue;
    }
    try {
      const affected = await updatePageMetadata(userId, page.id, {
        relationshipTier: tier,
      });
      if (affected === 0) {
        summary.failed++;
        continue;
      }
      summary.updated++;
    } catch (err) {
      summary.failed++;
      log.warn('relationship-tier backfill: updatePageMetadata failed', {
        userId,
        pageId: page.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (summary.attempted > 0) {
    log.info('relationship-tier backfill pass complete', {
      userId,
      ...summary,
    });
  }
  return summary;
}
