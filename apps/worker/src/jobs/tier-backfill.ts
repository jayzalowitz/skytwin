import { createLogger } from '@skytwin/core';
import {
  findPagesMissingAuthoringTier,
  updatePageMetadata,
} from '@skytwin/memory-gbrain-crdb-adapter';
import {
  classifyEmailAuthoringTier,
  extractBareAddress,
  splitAddressList,
  type AuthoringTier,
} from '@skytwin/connectors';

const log = createLogger('tier-backfill');

/**
 * Backfill `metadata.authoringTier` (and `metadata.fromAddress`) on
 * brain_pages that predate Layer 1 of #251 — pages that were indexed
 * before the Gmail connector started stamping the tier on signal data,
 * or pages where the metadata projection was skipped for any reason.
 *
 * Two reclassification paths, tried in order:
 *
 *   1. **Trust the signal.** If `signal.data.authoringTier` already
 *      exists (post-#252 ingest), copy it straight to the page metadata.
 *      Cheap and lossless — same tier the connector would produce.
 *   2. **Reclassify from raw headers.** Post-#251-backfill the connector
 *      also persists `to` / `cc` / `inReplyTo` / `listUnsubscribe` /
 *      `listId` / `labels` in `signal.data`. Run the classifier locally.
 *
 * Pages whose signal carries neither path (very old pre-Layer-1 ingest)
 * are logged as "unreclassifiable" and left alone — the only way to
 * recover their tier is a re-fetch from Gmail, which lives in a
 * separate sub-issue.
 *
 * The job is idempotent: running it twice on the same corpus does
 * nothing the second time, since the find query filters on
 * `metadata->>'authoringTier' IS NULL`.
 */
export interface TierBackfillOptions {
  /** Max pages to process per pass. Default 200. */
  batchSize?: number;
  /** When set, only backfill pages owned by this user. Default: all users. */
  userId?: string | null;
}

export interface TierBackfillSummary {
  attempted: number;
  /** Tier copied from `signal.data.authoringTier`. */
  copiedFromSignal: number;
  /** Tier re-derived by running the classifier on raw headers. */
  reclassified: number;
  /** Signal had no usable data; left unchanged. */
  unreclassifiable: number;
  /** updatePageMetadata threw. */
  failed: number;
}

/**
 * Run a single tier-backfill pass.
 */
export async function runTierBackfillJob(
  opts: TierBackfillOptions = {},
): Promise<TierBackfillSummary> {
  const batchSize = opts.batchSize ?? 200;
  const scope = opts.userId ?? null;

  const summary: TierBackfillSummary = {
    attempted: 0,
    copiedFromSignal: 0,
    reclassified: 0,
    unreclassifiable: 0,
    failed: 0,
  };

  let pages: Array<{
    page_id: string;
    user_id: string;
    signal_data: Record<string, unknown>;
  }>;
  try {
    pages = await findPagesMissingAuthoringTier(scope, batchSize);
  } catch (err) {
    log.warn('findPagesMissingAuthoringTier failed; skipping pass', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return summary;
  }

  for (const row of pages) {
    summary.attempted++;
    const result = deriveTierFromSignal(row.signal_data);
    if (result === null) {
      summary.unreclassifiable++;
      continue;
    }
    const patch: Record<string, unknown> = { authoringTier: result.tier };
    if (result.fromAddress) {
      patch['fromAddress'] = result.fromAddress;
    }
    try {
      await updatePageMetadata(row.user_id, row.page_id, patch);
      if (result.source === 'signal-tier') summary.copiedFromSignal++;
      else summary.reclassified++;
    } catch (err) {
      summary.failed++;
      log.warn('tier backfill: updatePageMetadata failed', {
        pageId: row.page_id,
        userId: row.user_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (summary.attempted > 0) {
    log.info('tier backfill pass complete', { ...summary });
  }
  return summary;
}

interface DerivedTier {
  tier: AuthoringTier;
  /** Normalized bare address; undefined when `data.from` was missing. */
  fromAddress?: string;
  source: 'signal-tier' | 'reclassified';
}

/**
 * Pull an `AuthoringTier` out of a stored signal's `data` blob. Prefers
 * the already-classified `data.authoringTier` (when present); falls back
 * to running the classifier locally on the raw headers. Returns `null`
 * if neither path works — caller logs as unreclassifiable.
 */
function deriveTierFromSignal(data: Record<string, unknown>): DerivedTier | null {
  const tier = data['authoringTier'];
  const rawFrom = typeof data['from'] === 'string' ? (data['from'] as string) : '';
  const fromAddress = rawFrom ? extractBareAddress(rawFrom) : '';

  if (isAuthoringTier(tier)) {
    return {
      tier,
      ...(fromAddress ? { fromAddress } : {}),
      source: 'signal-tier',
    };
  }

  // Reclassify path requires at least labels OR from to produce a
  // meaningful tier. Anything less and the classifier defaults to
  // inbox_personal, which would silently wrong-tier pages.
  const labels = Array.isArray(data['labels']) ? (data['labels'] as string[]) : [];
  const toRaw = typeof data['to'] === 'string' ? (data['to'] as string) : '';
  const ccRaw = typeof data['cc'] === 'string' ? (data['cc'] as string) : '';
  const inReplyTo = typeof data['inReplyTo'] === 'string' ? (data['inReplyTo'] as string) : '';
  const listUnsubscribe =
    typeof data['listUnsubscribe'] === 'string' ? (data['listUnsubscribe'] as string) : '';
  const listId = typeof data['listId'] === 'string' ? (data['listId'] as string) : '';

  const enoughData = labels.length > 0 || rawFrom.length > 0;
  if (!enoughData) return null;

  const classified = classifyEmailAuthoringTier({
    labels,
    fromAddress: rawFrom,
    toAddresses: splitAddressList(toRaw),
    ccAddresses: splitAddressList(ccRaw),
    hasInReplyTo: inReplyTo.trim().length > 0,
    hasListUnsubscribe: listUnsubscribe.trim().length > 0,
    listId,
  });
  return {
    tier: classified,
    ...(fromAddress ? { fromAddress } : {}),
    source: 'reclassified',
  };
}

function isAuthoringTier(v: unknown): v is AuthoringTier {
  return (
    v === 'user_sent_originated' ||
    v === 'user_sent_reply' ||
    v === 'inbox_personal' ||
    v === 'inbox_broadcast' ||
    v === 'inbox_newsletter' ||
    v === 'inbox_automated'
  );
}
