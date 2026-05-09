import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  modelDownloadRepository,
  type ModelDownloadRow,
} from '@skytwin/db';
import { findById as findModelById } from '@skytwin/embedded-llm';
import { createLogger } from '@skytwin/core';

const log = createLogger('api:embedded-llm:downloader');

/**
 * Default model directory when `SKYTWIN_LLAMA_MODELS` is unset:
 * `~/.skytwin/models/llama`. Created lazily on first download.
 *
 * The runtime detector (#187 AC#1) reads `SKYTWIN_LLAMA_MODELS` to find
 * GGUFs; we honor that env var as the override but provide a sensible
 * default so a fresh install doesn't need any environment configuration.
 */
export function resolveModelDir(): string {
  const fromEnv = process.env['SKYTWIN_LLAMA_MODELS'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(homedir(), '.skytwin', 'models', 'llama');
}

/**
 * Compute the absolute target path for a registry model. The basename
 * is `<modelId>.gguf`. We never use the registry's URL filename — that
 * could be anything (or could change over time without our control).
 *
 * Final paths are *not* namespaced by user — the GGUF is content-
 * addressable (we verify SHA-256 before rename), so two users on the
 * same host downloading the same model land identical bytes at the
 * same path. The race-prone bit is the in-flight `.partial`, which
 * `partialPathFor()` namespaces by download row id below.
 */
export function targetPathFor(modelId: string): string {
  return join(resolveModelDir(), `${modelId}.gguf`);
}

/**
 * In-flight downloads write to a per-row partial so concurrent downloads
 * of the same model by different users (or even the same user across
 * cancel/retry cycles) can't corrupt each other's stream. After verify,
 * we atomically rename to the shared final path.
 */
function partialPathFor(targetPath: string, downloadId: string): string {
  return `${targetPath}.${downloadId}.partial`;
}

/**
 * In-flight download registry. Lets `pause` flip a flag the streamer
 * checks per chunk, and lets `cancel` abort the underlying request.
 *
 * Survives only the lifetime of the API process. Crash → DB row stays
 * in 'downloading'; boot-time `recoverOrphanedDownloads` flips those
 * to 'paused' so the user can manually resume.
 */
interface InFlightDownload {
  controller: AbortController;
  paused: boolean;
  cancelled: boolean;
}
const inFlight = new Map<string, InFlightDownload>();

export interface StartDownloadResult {
  download: ModelDownloadRow;
  resumed: boolean;
}

/**
 * Start (or resume) a download. Idempotent on (userId, modelId): a
 * pending/downloading/paused row is reused; only complete/failed/
 * cancelled rows let a fresh start happen.
 *
 * The actual byte transfer runs asynchronously — caller gets the
 * created/resumed row immediately and polls `/downloads/:id` for
 * progress.
 */
export async function startDownload(
  userId: string,
  modelId: string,
): Promise<StartDownloadResult> {
  const model = findModelById(modelId);
  if (!model) {
    throw new Error(`unknown model id: ${modelId}`);
  }

  const dir = resolveModelDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const targetPath = targetPathFor(modelId);

  const existing = await modelDownloadRepository.findActive(userId, modelId);
  let download: ModelDownloadRow;
  let resumed = false;

  if (existing !== null) {
    download = existing;
    resumed = existing.bytes_downloaded > 0;
  } else {
    try {
      download = await modelDownloadRepository.create({
        userId,
        modelId,
        targetPath,
        totalBytes: model.approxBytes,
        sha256Expected: model.sha256,
      });
    } catch (err) {
      // The DB-level unique partial index can reject concurrent inserts
      // that both passed findActive(). Re-fetch and treat as resumed.
      if (isUniqueViolation(err)) {
        const refetch = await modelDownloadRepository.findActive(userId, modelId);
        if (refetch === null) throw err;
        download = refetch;
        resumed = refetch.bytes_downloaded > 0;
      } else {
        throw err;
      }
    }
  }

  // If a runner is already executing for this row, skip kicking off a
  // second one — two concurrent .partial writers would corrupt the
  // file. The active runner will keep streaming and the caller polls
  // for progress on the same row.
  if (inFlight.has(download.id)) {
    return { download, resumed };
  }

  // Kick off the async transfer. Caller doesn't await this — it polls
  // the row for status. Errors land in `error` + status='failed'.
  void runDownload(download).catch((err) => {
    log.warn('download runner threw', {
      downloadId: download.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { download, resumed };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === '23505';
}

/**
 * Pause an in-flight download. Sets the in-memory flag (the streamer
 * checks it per-chunk) and updates the DB row to 'paused'. The
 * `<target_path>.partial` file stays on disk for resume.
 *
 * Pausing a non-active download (already complete / failed / cancelled
 * / not-yet-started) is a no-op that returns `false`.
 */
export async function pauseDownload(downloadId: string): Promise<boolean> {
  const row = await modelDownloadRepository.findById(downloadId);
  if (!row) return false;
  if (row.status !== 'downloading' && row.status !== 'pending') return false;

  const handle = inFlight.get(downloadId);
  if (handle) {
    handle.paused = true;
    handle.controller.abort();
    inFlight.delete(downloadId);
  }
  await modelDownloadRepository.setStatus(downloadId, 'paused');
  return true;
}

/**
 * Cancel and clean up. Aborts in-flight transfer, deletes the
 * `<target_path>.partial` file, marks the row 'cancelled'.
 */
export async function cancelDownload(downloadId: string): Promise<boolean> {
  const row = await modelDownloadRepository.findById(downloadId);
  if (!row) return false;
  if (row.status === 'complete' || row.status === 'cancelled') return false;

  const handle = inFlight.get(downloadId);
  if (handle) {
    handle.cancelled = true;
    handle.controller.abort();
    inFlight.delete(downloadId);
  }

  const partial = partialPathFor(row.target_path, downloadId);
  if (existsSync(partial)) {
    try {
      unlinkSync(partial);
    } catch (err) {
      log.warn('failed to delete partial file on cancel', {
        downloadId,
        partial,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await modelDownloadRepository.setStatus(downloadId, 'cancelled');
  return true;
}

/**
 * Async byte transfer. Reads any existing `.partial` size, sends a
 * Range request from there, streams to disk, updates progress every
 * ~1MB. On EOF: SHA-256 verify (if registry hash isn't placeholder),
 * atomic rename to final path, mark complete.
 */
async function runDownload(download: ModelDownloadRow): Promise<void> {
  const model = findModelById(download.model_id);
  if (!model) {
    await modelDownloadRepository.setStatus(download.id, 'failed', {
      error: `unknown model id: ${download.model_id}`,
    });
    return;
  }

  // Pause/cancel can fire between startDownload() returning the row
  // and runDownload() picking up the async kickoff. The DB is the
  // source of truth for that intent — re-fetch and bail if the user
  // already changed their mind. Without this, a quick pause-on-pending
  // would be silently overwritten back to 'downloading'.
  const current = await modelDownloadRepository.findById(download.id);
  if (!current) return; // row was deleted somehow
  if (current.status === 'paused' || current.status === 'cancelled'
      || current.status === 'complete' || current.status === 'failed') {
    return;
  }

  const partialPath = partialPathFor(download.target_path, download.id);
  // Only resume from the partial if THIS row had progress recorded.
  // A fresh row (bytes_downloaded === 0) finding a partial on disk
  // means the previous attempt didn't clean up — e.g., a cancel that
  // failed to unlink on Windows. Resuming from those stale bytes
  // would corrupt the download.
  let resumeFrom = 0;
  if (download.bytes_downloaded > 0 && existsSync(partialPath)) {
    try {
      resumeFrom = statSync(partialPath).size;
    } catch {
      resumeFrom = 0;
    }
  } else if (existsSync(partialPath)) {
    try { unlinkSync(partialPath); } catch { /* best effort */ }
  }

  const controller = new AbortController();
  const handle: InFlightDownload = { controller, paused: false, cancelled: false };
  inFlight.set(download.id, handle);

  await modelDownloadRepository.setStatus(download.id, 'downloading', {
    bytesDownloaded: resumeFrom,
  });

  let response: Response;
  try {
    const headers: Record<string, string> = {};
    if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`;
    response = await fetch(model.downloadUrl, {
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    inFlight.delete(download.id);
    if (handle.paused || handle.cancelled) return; // status already set
    await modelDownloadRepository.setStatus(download.id, 'failed', {
      error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // 206 Partial Content (resume) or 200 OK (full). Any other status
  // is a hard failure — the registry URL changed, was rate-limited,
  // or the host is down.
  if (response.status !== 200 && response.status !== 206) {
    inFlight.delete(download.id);
    await modelDownloadRepository.setStatus(download.id, 'failed', {
      error: `HTTP ${response.status} from ${model.downloadUrl}`,
    });
    return;
  }
  // Range requests on a server that doesn't support them return 200
  // with the whole body — start over from 0.
  if (resumeFrom > 0 && response.status === 200) {
    log.info('Server ignored Range header — restarting from 0', {
      downloadId: download.id,
    });
    resumeFrom = 0;
    if (existsSync(partialPath)) {
      try { unlinkSync(partialPath); } catch { /* best effort */ }
    }
    // Persist the reset immediately so the polling UI doesn't briefly
    // report a stale `bytes_downloaded` until the next 1MB flush.
    await modelDownloadRepository.updateProgress(download.id, 0);
  }
  if (response.body === null) {
    inFlight.delete(download.id);
    await modelDownloadRepository.setStatus(download.id, 'failed', {
      error: 'response body was null',
    });
    return;
  }

  // Update total_bytes from Content-Length when the registry's
  // approxBytes was off — the UI uses total_bytes for the progress bar
  // denominator, so it should match what we're actually fetching.
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10);
    if (Number.isFinite(len) && len > 0) {
      const totalFromServer = response.status === 206 ? resumeFrom + len : len;
      if (Math.abs(totalFromServer - download.total_bytes) > 1024 * 1024) {
        await modelDownloadRepository.updateTotalBytes(download.id, totalFromServer);
      }
    }
  }

  const PROGRESS_FLUSH_BYTES = 1024 * 1024; // flush DB every 1MB
  let bytesSinceFlush = 0;
  let totalBytes = resumeFrom;
  const out = createWriteStream(partialPath, {
    flags: resumeFrom > 0 ? 'a' : 'w',
  });

  // Convert the web-stream Response.body into a Node Readable so
  // pipeline + abort signal work uniformly.
  const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

  try {
    nodeStream.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      bytesSinceFlush += chunk.length;
      if (bytesSinceFlush >= PROGRESS_FLUSH_BYTES) {
        bytesSinceFlush = 0;
        // Fire-and-forget — don't await per-chunk writes
        void modelDownloadRepository.updateProgress(download.id, totalBytes).catch(() => {});
      }
    });
    await pipeline(nodeStream, out);
  } catch (err) {
    inFlight.delete(download.id);
    if (handle.paused) {
      await modelDownloadRepository.setStatus(download.id, 'paused', {
        bytesDownloaded: totalBytes,
      });
      return;
    }
    if (handle.cancelled) return; // status already set by cancelDownload
    await modelDownloadRepository.setStatus(download.id, 'failed', {
      error: `transfer failed at ${totalBytes}/${download.total_bytes} bytes: ${err instanceof Error ? err.message : String(err)}`,
      bytesDownloaded: totalBytes,
    });
    return;
  }

  // Bail if the user clicked Cancel during the byte transfer. The
  // network stream finishes after a controller.abort(), so we may
  // arrive here with handle.cancelled already true.
  if (handle.cancelled) {
    inFlight.delete(download.id);
    return;
  }
  await modelDownloadRepository.setStatus(download.id, 'verifying', {
    bytesDownloaded: totalBytes,
  });

  // Verify SHA-256 unless the registry hash is the placeholder. The v1
  // registry ships with all-zeros sha256 fields pending real artifact
  // measurement; we still ship the verification path because the field
  // will get filled in upstream and we don't want a "the day we fill
  // in real hashes" code change.
  const expectedHash = model.sha256.toLowerCase();
  const isPlaceholder = /^0+$/.test(expectedHash);
  if (!isPlaceholder) {
    // Stream the file through the hash — multi-GB GGUFs would OOM the
    // API process if we readFile()'d the whole thing into memory.
    const actual = await computeSha256(partialPath);
    // Cancel can fire mid-hash. If it did, cancelDownload() already
    // marked the row 'cancelled' and removed the partial — don't
    // overwrite that with verify's outcome.
    if (handle.cancelled) {
      inFlight.delete(download.id);
      return;
    }
    if (actual !== expectedHash) {
      // Corrupt download. Delete the partial — user should retry,
      // and we don't want a half-bad GGUF lingering on disk.
      try { unlinkSync(partialPath); } catch { /* best effort */ }
      inFlight.delete(download.id);
      await modelDownloadRepository.setStatus(download.id, 'failed', {
        error: `sha256 mismatch: expected ${expectedHash}, got ${actual}`,
        bytesDownloaded: 0,
      });
      return;
    }
  }

  if (handle.cancelled) {
    inFlight.delete(download.id);
    return;
  }
  await modelDownloadRepository.setStatus(download.id, 'installing');
  // Atomic rename — partial → final. Same filesystem so this is O(1).
  try {
    if (existsSync(download.target_path)) unlinkSync(download.target_path);
    renameSync(partialPath, download.target_path);
  } catch (err) {
    inFlight.delete(download.id);
    if (handle.cancelled) return;
    await modelDownloadRepository.setStatus(download.id, 'failed', {
      error: `install (rename) failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  inFlight.delete(download.id);
  if (handle.cancelled) return;
  await modelDownloadRepository.setStatus(download.id, 'complete');
  log.info('Model download complete', {
    downloadId: download.id,
    modelId: download.model_id,
    targetPath: download.target_path,
  });
}

/**
 * Boot-time recovery. Called once on API startup before any download
 * route is served — flips orphaned 'downloading' rows to 'paused' so
 * the user can resume.
 */
export async function recoverOnBoot(): Promise<void> {
  try {
    const recovered = await modelDownloadRepository.recoverOrphanedDownloads();
    if (recovered > 0) {
      log.info('Recovered orphaned model downloads to paused', { count: recovered });
    }
  } catch (err) {
    // Don't crash the API if recovery fails — just log.
    log.warn('Failed to recover orphaned downloads', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Stream the file through a SHA-256 hash. Multi-GB GGUFs would OOM
 * the API process if we loaded them into memory whole.
 */
async function computeSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
