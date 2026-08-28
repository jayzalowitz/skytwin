import { withRetry, RetryableHttpError, createLogger } from '@skytwin/core';
import type { RawSignal } from '@skytwin/shared-types';

const log = createLogger('idle-miner:emitter');

// HTTP statuses worth retrying (transient). 408 Request Timeout and 429 are
// transient alongside the 5xx family; everything else (other 4xx) is a permanent
// failure for this request and is not retried.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Cap on the serialized file-derived metadata. The miner emits bounded metadata
// by design (a package.json name, a git remote — never file content), so this
// only fires on pathological input; oversized `extracted` is dropped rather than
// ballooning the request body.
const MAX_EXTRACTED_BYTES = 64 * 1024;

/**
 * A permanent (non-retryable) ingest failure — a 4xx other than 408/429, i.e. a
 * likely misconfiguration (wrong URL, auth, payload schema). Distinguished from
 * transient failures so the emitter can log it loudly instead of burying a
 * standing config error among per-signal retry warnings.
 */
class PermanentIngestError extends Error {}

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
 * semi-trusted. They are kept entirely OUT of the top level — nested under a
 * single `extracted` key — so they can neither shadow a trusted envelope field
 * (`source` / `type` / `signalId` / `userId`) nor inject arbitrary top-level
 * ingest keys (including a `__proto__` key that an unsafe downstream merge might
 * honor). Everything at the top level is controlled by this function.
 */
export function toIngestEvent(signal: RawSignal, userId: string): Record<string, unknown> {
  let extracted: Record<string, unknown> | undefined;
  const raw = signal.structuredFields;
  if (raw && typeof raw === 'object') {
    try {
      // Drop pathologically-large metadata rather than send an oversized body.
      if (JSON.stringify(raw).length <= MAX_EXTRACTED_BYTES) extracted = raw;
    } catch {
      // Non-serializable (e.g. a cycle) → omit.
    }
  }
  return {
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
    ...(extracted ? { extracted } : {}),
  };
}

export interface HttpSignalEmitterOptions {
  /** Full ingest URL, e.g. `http://localhost:3200/api/events/ingest`. */
  ingestUrl: string;
  /** The user the mined signals are attributed to. */
  userId: string;
  /**
   * Loopback service credential (`SKYTWIN_SERVICE_TOKEN`), sent as
   * the `X-SkyTwin-Service-Token` header. Required whenever the API runs with the
   * localhost dev bypass off — which is every packaged desktop build, since
   * the desktop pins `NODE_ENV=production` for its children. Omit it only in
   * a dev environment where the bypass is active.
   */
  serviceToken?: string;
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
  const serviceToken = opts.serviceToken?.trim();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Dedicated header rather than `Authorization` — see the note in
    // apps/worker/src/ingest-headers.ts on the web-proxy laundering path.
    ...(serviceToken ? { 'X-SkyTwin-Service-Token': serviceToken } : {}),
  };
  return async (signal: RawSignal): Promise<void> => {
    const body = JSON.stringify(toIngestEvent(signal, opts.userId));
    try {
      await withRetry(
        async () => {
          const resp = await fetchFn(opts.ingestUrl, {
            method: 'POST',
            headers,
            body,
          });
          if (!resp.ok) {
            if (RETRYABLE_STATUS.has(resp.status)) {
              // Retryable: withRetry backs off and tries again.
              throw new RetryableHttpError(resp.status, `ingest returned ${resp.status}`, null);
            }
            // Permanent: not retried by withRetry, and surfaced loudly below.
            throw new PermanentIngestError(`ingest returned ${resp.status}`);
          }
        },
        { maxRetries, baseDelayMs: 500 },
      );
    } catch (err) {
      // Never crash the scan. But distinguish a likely-permanent misconfiguration
      // (wrong URL / auth / payload schema → 4xx) from a transient drop (5xx /
      // network, retried then given up): a standing config error must be visible
      // at error severity, not buried among per-signal retry warnings.
      const detail = {
        signalId: signal.id,
        error: err instanceof Error ? err.message : String(err),
      };
      if (err instanceof PermanentIngestError) {
        log.error('idle-miner signal emit rejected (check ingestUrl / auth / payload schema)', detail);
      } else {
        log.warn('idle-miner signal emit failed (dropped; re-attempted on a later scan)', detail);
      }
    }
  };
}
