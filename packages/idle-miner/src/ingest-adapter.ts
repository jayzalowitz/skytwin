import { withRetry, RetryableHttpError, createLogger } from '@skytwin/core';
import type { RawSignal } from '@skytwin/shared-types';

const log = createLogger('idle-miner:emitter');

// HTTP statuses worth retrying. Everything else (4xx other than 429) is a
// permanent failure for this request and is not retried.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Map an idle-miner filesystem `RawSignal` into the body the SkyTwin
 * `/api/events/ingest` endpoint expects.
 *
 * The endpoint dispatches on `source` / `type`, so the filesystem signal is
 * wrapped in that envelope with `source: 'fs'` (which capability inference maps
 * to `kind: 'fs'`). Note this is a DIFFERENT shape than the connector `RawSignal`
 * the worker forwards — hence the explicit mapping rather than a pass-through.
 *
 * SECURITY: the extracted `structuredFields` (a package.json `name`, a git
 * remote URL, …) are derived from the user's file CONTENT and are therefore only
 * semi-trusted. They are spread FIRST so the trusted envelope fields — `source`,
 * `type`, `signalId`, `userId` — always win. A file must never be able to set
 * `source: 'gmail'` or re-attribute the signal to another `userId` by naming a
 * structured field after an envelope key.
 */
export function toIngestEvent(signal: RawSignal, userId: string): Record<string, unknown> {
  return {
    ...(signal.structuredFields ?? {}),
    source: 'fs',
    type: signal.skippedReason ? 'file_skipped' : 'file_indexed',
    signalId: signal.id,
    userId,
    rootId: signal.rootId,
    relPath: signal.relPath,
    absPath: signal.absPath,
    sizeBytes: signal.sizeBytes,
    mtimeMs: signal.mtimeMs,
    ...(signal.mimeType !== undefined ? { mimeType: signal.mimeType } : {}),
    ...(signal.contentHash !== undefined ? { contentHash: signal.contentHash } : {}),
    ...(signal.skippedReason !== undefined ? { skippedReason: signal.skippedReason } : {}),
  };
}

export interface HttpSignalEmitterOptions {
  /** Full ingest URL, e.g. `http://localhost:3200/api/events/ingest`. */
  ingestUrl: string;
  /** The user the mined signals are attributed to. */
  userId: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Max retries on transient (429 / 5xx / network) failures. Default 2. */
  maxRetries?: number;
}

/**
 * Build a `signalEmitter` (the `MinerOptions.signalEmitter` shape) that POSTs
 * each mined signal to the SkyTwin ingest endpoint. The package requires a
 * `signalEmitter` but shipped no default — this is the standard HTTP one, paired
 * with `SnapshotFileStore` so a host has the full dependency set off the shelf.
 *
 * It NEVER throws into the miner loop. Transient failures (429 / 5xx / network)
 * are retried with bounded exponential backoff; a final failure is logged and
 * swallowed. The durable file index means a dropped signal is re-attempted on a
 * later scan, so crashing the whole scan over one failed POST would be strictly
 * worse than swallowing it.
 */
export function createHttpSignalEmitter(
  opts: HttpSignalEmitterOptions,
): (signal: RawSignal) => Promise<void> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 2;
  return async (signal: RawSignal): Promise<void> => {
    const body = JSON.stringify(toIngestEvent(signal, opts.userId));
    try {
      await withRetry(
        async () => {
          const resp = await fetchFn(opts.ingestUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          if (!resp.ok) {
            if (RETRYABLE_STATUS.has(resp.status)) {
              // Retryable: withRetry backs off and tries again.
              throw new RetryableHttpError(resp.status, `ingest returned ${resp.status}`, null);
            }
            // Permanent: a plain Error is NOT retried by withRetry.
            throw new Error(`ingest returned ${resp.status}`);
          }
        },
        { maxRetries, baseDelayMs: 500 },
      );
    } catch (err) {
      log.warn('idle-miner signal emit failed (dropped; re-attempted on a later scan)', {
        signalId: signal.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
