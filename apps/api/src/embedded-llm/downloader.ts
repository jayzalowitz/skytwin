import { randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { modelDownloadRepository, type ModelDownloadRow } from "@skytwin/db";
import {
  activateManagedModel,
  computeFileSha256Async,
  findById as findModelById,
  inspectManagedActiveModel,
  managedArtifactPath,
  type ManagedModelInspection,
  type ModelEntry,
} from "@skytwin/embedded-llm";
import { createLogger } from "@skytwin/core";
import {
  ArtifactTransferError,
  DiskReservationLedger,
  assertSufficientDisk,
  fetchApprovedArtifact,
  requiredAvailableBytes,
  type ResumeValidator,
} from "./artifact-transfer.js";

const log = createLogger("api:embedded-llm:downloader");

/**
 * Default model directory when `SKYTWIN_LLAMA_MODELS` is unset:
 * `~/.skytwin/models/llama`. Created lazily on first download.
 *
 * The runtime detector (#187 AC#1) reads `SKYTWIN_LLAMA_MODELS` to find
 * GGUFs; we honor that env var as the override but provide a sensible
 * default so a fresh install doesn't need any environment configuration.
 */
export function resolveModelDir(): string {
  const fromEnv = process.env["SKYTWIN_LLAMA_MODELS"];
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);
  return resolve(homedir(), ".skytwin", "models", "llama");
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
  const model = findModelById(modelId);
  if (!model) throw new Error(`unknown model id: ${modelId}`);
  return managedArtifactPath(resolveModelDir(), model);
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

interface PartialState {
  schemaVersion: 1;
  modelId: string;
  revision: string;
  sourceUrl: string;
  exactBytes: number;
  bytesDownloaded: number;
  validator: ResumeValidator;
}

function partialStatePath(partialPath: string): string {
  return `${partialPath}.json`;
}
function resumablePartialSize(path: string): number {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(fd);
    return stats.isFile() && stats.nlink === 1 ? stats.size : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
function writePartialState(path: string, state: PartialState): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    try {
      const directoryFd = openSync(dirname(path), "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch {
      /* platform does not support directory fsync */
    }
  } catch (error) {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch {
        /* best effort */
      }
    }
    throw error;
  }
}
function readPartialState(path: string): PartialState | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1) return null;
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const state = value as PartialState;
    if (
      state.schemaVersion !== 1 ||
      typeof state.modelId !== "string" ||
      typeof state.revision !== "string" ||
      typeof state.sourceUrl !== "string" ||
      !Number.isSafeInteger(state.exactBytes) ||
      !Number.isSafeInteger(state.bytesDownloaded) ||
      typeof state.validator !== "object" ||
      state.validator === null ||
      (state.validator.etag !== undefined &&
        typeof state.validator.etag !== "string") ||
      (state.validator.lastModified !== undefined &&
        typeof state.validator.lastModified !== "string")
    )
      return null;
    return state;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function restorePartialCheckpoint(
  partialPath: string,
  download: Pick<ModelDownloadRow, "model_id" | "bytes_downloaded">,
  model: NonNullable<ReturnType<typeof findModelById>>,
): {
  resumeFrom: number;
  validator: ResumeValidator;
  device: bigint;
  inode: bigint;
} {
  let fd: number | null = null;
  try {
    fd = openSync(partialPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const partialStats = fstatSync(fd, { bigint: true });
    if (!partialStats.isFile() || partialStats.nlink !== 1n) {
      throw new ArtifactTransferError(
        "resume_state_mismatch",
        "Partial artifact must be a private regular file",
      );
    }
    const localBytes = Number(partialStats.size);
    const state = readPartialState(partialStatePath(partialPath));
    const agrees =
      state !== null &&
      state.modelId === model.id &&
      download.model_id === model.id &&
      state.revision === model.source.revision &&
      state.sourceUrl === model.source.downloadUrl &&
      state.exactBytes === model.exactBytes &&
      state.bytesDownloaded >= download.bytes_downloaded &&
      localBytes >= state.bytesDownloaded &&
      download.bytes_downloaded > 0 &&
      state.bytesDownloaded <= model.exactBytes &&
      Boolean(state.validator.etag || state.validator.lastModified);
    if (!agrees || state === null) {
      throw new ArtifactTransferError(
        "resume_state_mismatch",
        "Partial file, database and HTTP validator did not agree",
      );
    }
    // The state file is persisted before the DB CAS. If a crash lands in that
    // small window, the DB's older checkpoint remains the committed boundary.
    if (localBytes > download.bytes_downloaded)
      ftruncateSync(fd, download.bytes_downloaded);
    return {
      resumeFrom: download.bytes_downloaded,
      validator: state.validator,
      device: partialStats.dev,
      inode: partialStats.ino,
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
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
  timedOut: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
}
const inFlight = new Map<string, InFlightDownload>();
const diskReservations = new DiskReservationLedger();
let startMutationTail: Promise<void> = Promise.resolve();

async function serializeDownloadStart<T>(operation: () => Promise<T>): Promise<T> {
  const previous = startMutationTail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  startMutationTail = previous.then(() => gate);
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Bound stalled connections without imposing a wall-clock limit on slow links. */
export const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

function clearInactivityTimer(handle: InFlightDownload): void {
  if (handle.timeout !== null) clearTimeout(handle.timeout);
  handle.timeout = null;
}

function armInactivityTimer(handle: InFlightDownload, timeoutMs: number): void {
  clearInactivityTimer(handle);
  handle.timeout = setTimeout(() => {
    handle.timedOut = true;
    handle.controller.abort();
  }, timeoutMs);
  handle.timeout.unref();
}

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

  return serializeDownloadStart(async () => {
    const dir = resolveModelDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const targetPath = targetPathFor(modelId);

    const existing = await modelDownloadRepository.findActive(userId, modelId);
    let download: ModelDownloadRow;
    let resumed = false;
    let partialBytes = 0;

    if (existing !== null) {
      download = existing;
      resumed = existing.bytes_downloaded > 0;
      const partial = partialPathFor(existing.target_path, existing.id);
      partialBytes = resumablePartialSize(partial);
    } else {
      // Check and reserve are serialized so concurrent starts cannot each
      // spend the same free bytes. Check before insert to avoid a stranded row.
      assertSufficientDisk(
        dir,
        model.exactBytes,
        0,
        diskReservations.totalBytes,
      );
      try {
        download = await modelDownloadRepository.create({
          userId,
          modelId,
          targetPath,
          totalBytes: model.exactBytes,
          sha256Expected: model.sha256,
        });
      } catch (err) {
        // The DB-level unique partial index can reject concurrent inserts
        // that both passed findActive(). Re-fetch and treat as resumed.
        if (isUniqueViolation(err)) {
          const refetch = await modelDownloadRepository.findActive(
            userId,
            modelId,
          );
          if (refetch === null) throw err;
          download = refetch;
          resumed = refetch.bytes_downloaded > 0;
        } else {
          throw err;
        }
      }
    }

    // If a runner is already executing for this row, skip kicking off a
    // second one — two concurrent .partial writers would corrupt the file.
    if (inFlight.has(download.id)) return { download, resumed };

    if (existing !== null)
      assertSufficientDisk(
        dir,
        model.exactBytes,
        partialBytes,
        diskReservations.totalBytes,
      );
    diskReservations.reserve(
      download.id,
      requiredAvailableBytes(model.exactBytes, partialBytes),
    );

    // Kick off the async transfer. Caller polls the row for progress.
    void runDownload(download).catch((err) => {
      log.warn("download runner threw", {
        downloadId: download.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { download, resumed };
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "23505";
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
  if (row.status !== "downloading" && row.status !== "pending") return false;

  const handle = inFlight.get(downloadId);
  if (handle) {
    handle.paused = true;
    clearInactivityTimer(handle);
    handle.controller.abort();
    // The runner syncs the file and commits the durable boundary before it
    // transitions the row. Keeping the handle prevents a second writer.
    return true;
  }
  return modelDownloadRepository.transitionStatus(
    downloadId,
    ["pending"],
    "paused",
  );
}

/**
 * Cancel and clean up. Aborts in-flight transfer, deletes this row's
 * partial (`<target_path>.<downloadId>.partial`), marks the row
 * 'cancelled'. The shared final GGUF at `<target_path>` is left alone.
 */
export async function cancelDownload(downloadId: string): Promise<boolean> {
  const row = await modelDownloadRepository.findById(downloadId);
  if (!row) return false;
  // Atomic activation is deliberately non-interruptible. Once installation
  // begins, cancellation must not race the manifest switch and report a model
  // cancelled after it became active.
  if (
    row.status === "complete" ||
    row.status === "cancelled" ||
    row.status === "installing"
  )
    return false;

  const transitioned = await modelDownloadRepository.transitionStatus(
    downloadId,
    ["pending", "downloading", "paused", "verifying", "failed"],
    "cancelled",
  );
  if (!transitioned) return false;

  const handle = inFlight.get(downloadId);
  if (handle) {
    handle.cancelled = true;
    clearInactivityTimer(handle);
    handle.controller.abort();
    inFlight.delete(downloadId);
  }

  const model = findModelById(row.model_id);
  const expectedTarget = model
    ? managedArtifactPath(resolveModelDir(), model)
    : null;
  if (expectedTarget === null || resolve(row.target_path) !== expectedTarget) {
    log.warn(
      "refused model-download cleanup outside the managed artifact path",
      {
        downloadId,
        modelId: row.model_id,
      },
    );
    return true;
  }
  const partial = partialPathFor(expectedTarget, downloadId);
  if (existsSync(partial)) {
    try {
      unlinkSync(partial);
    } catch (err) {
      log.warn("failed to delete partial file on cancel", {
        downloadId,
        partial,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const statePath = partialStatePath(partial);
  if (existsSync(statePath)) {
    try {
      unlinkSync(statePath);
    } catch {
      /* best effort */
    }
  }

  return true;
}

/**
 * Async byte transfer. Reads any existing `.partial` size, sends a
 * Range request from there, streams to disk, updates progress every
 * at durable checkpoints. On EOF: exact-size and SHA-256 verification,
 * atomic rename to final path, mark complete.
 */
export interface DownloadRunnerDependencies {
  findModel: (id: string) => ModelEntry | null;
  fetchArtifact: typeof fetchApprovedArtifact;
  hashFile: typeof computeFileSha256Async;
  activate: typeof activateManagedModel;
  openPartial: typeof open;
  modelDir: () => string;
  inactivityTimeoutMs: number;
}

const DEFAULT_RUNNER_DEPENDENCIES: DownloadRunnerDependencies = {
  findModel: findModelById,
  fetchArtifact: fetchApprovedArtifact,
  hashFile: computeFileSha256Async,
  activate: activateManagedModel,
  openPartial: open,
  modelDir: resolveModelDir,
  inactivityTimeoutMs: DOWNLOAD_INACTIVITY_TIMEOUT_MS,
};

function runnerError(err: unknown, timedOut: boolean): string {
  if (timedOut) return "[timeout] Artifact transfer stalled; it can be resumed";
  if (err instanceof ArtifactTransferError)
    return `[${err.code}] ${err.message}`;
  return `[download_io_error] ${err instanceof Error ? err.message : "Model download failed"}`;
}

function isResumableInterruption(
  err: unknown,
  handle: InFlightDownload,
  phase: ModelDownloadRow["status"],
  durableBytes: number,
): boolean {
  if (phase !== "downloading") return false;
  if (handle.timedOut) return true;
  if (err instanceof ArtifactTransferError) {
    return (
      err.code === "network_error" ||
      err.code === "timeout" ||
      err.code === "source_unavailable" ||
      err.code === "cancelled"
    );
  }
  // A close or sidecar failure after an earlier committed checkpoint is
  // resumable from that boundary even though the newest tail is discarded.
  return durableBytes > 0;
}

async function commitDurableCheckpoint(input: {
  out: FileHandle;
  partialPath: string;
  downloadId: string;
  model: ModelEntry;
  bytesDownloaded: number;
  validator: ResumeValidator;
}): Promise<boolean> {
  // This order is the durability contract: bytes, then sidecar, then DB CAS.
  await input.out.sync();
  writePartialState(partialStatePath(input.partialPath), {
    schemaVersion: 1,
    modelId: input.model.id,
    revision: input.model.source.revision,
    sourceUrl: input.model.source.downloadUrl,
    exactBytes: input.model.exactBytes,
    bytesDownloaded: input.bytesDownloaded,
    validator: input.validator,
  });
  return modelDownloadRepository.checkpointProgress(
    input.downloadId,
    input.bytesDownloaded,
  );
}

/** Exported for focused state-machine tests; production starts it via startDownload(). */
export async function runDownload(
  download: ModelDownloadRow,
  dependencies: DownloadRunnerDependencies = DEFAULT_RUNNER_DEPENDENCIES,
): Promise<void> {
  // Claim process-local ownership before the first await. This closes the
  // window where two concurrent start requests could both schedule runners
  // and overwrite each other's pause/cancel handle.
  if (inFlight.has(download.id)) return;
  const handle: InFlightDownload = {
    controller: new AbortController(),
    paused: false,
    cancelled: false,
    timedOut: false,
    timeout: null,
  };
  inFlight.set(download.id, handle);
  try {
    await runOwnedDownload(download, dependencies, handle);
  } finally {
    clearInactivityTimer(handle);
    diskReservations.release(download.id);
    if (inFlight.get(download.id) === handle) inFlight.delete(download.id);
  }
}

async function runOwnedDownload(
  download: ModelDownloadRow,
  dependencies: DownloadRunnerDependencies,
  handle: InFlightDownload,
): Promise<void> {
  const model = dependencies.findModel(download.model_id);
  if (!model) {
    await modelDownloadRepository.transitionStatus(
      download.id,
      ["pending", "paused"],
      "failed",
      {
        error: `unknown model id: ${download.model_id}`,
      },
    );
    return;
  }
  const modelDir = resolve(dependencies.modelDir());
  const expectedTarget = managedArtifactPath(modelDir, model);
  if (resolve(download.target_path) !== expectedTarget) {
    await modelDownloadRepository.transitionStatus(
      download.id,
      ["pending", "paused"],
      "failed",
      {
        error:
          "[managed_path_mismatch] Download row target is outside the registry-derived artifact path",
      },
    );
    return;
  }

  // Pause/cancel can fire between startDownload() returning the row
  // and runDownload() picking up the async kickoff. The DB is the
  // source of truth for that intent — re-fetch and bail if the user
  // already changed their mind. Without this, a quick pause-on-pending
  // would be silently overwritten back to 'downloading'.
  const current = await modelDownloadRepository.findById(download.id);
  if (!current) return; // row was deleted somehow
  if (
    (current.status === "paused" && download.status !== "paused") ||
    current.status === "cancelled" ||
    current.status === "complete" ||
    current.status === "failed"
  ) {
    return;
  }

  const partialPath = partialPathFor(download.target_path, download.id);
  // Migration: PR #247 wrote to a non-namespaced `<target>.partial`.
  // After this PR, partials are namespaced by download row id. Any
  // pre-namespacing partial on disk is orphan junk from before the
  // upgrade — clean it up unconditionally so it doesn't waste space
  // forever.
  const legacyPartial = `${download.target_path}.partial`;
  if (existsSync(legacyPartial)) {
    try {
      unlinkSync(legacyPartial);
    } catch {
      /* best effort */
    }
  }
  // Only resume from the partial if THIS row had progress recorded.
  // A fresh row (bytes_downloaded === 0) finding a partial on disk
  // means the previous attempt didn't clean up — e.g., a cancel that
  // failed to unlink on Windows. Resuming from those stale bytes
  // would corrupt the download.
  let resumeFrom = 0;
  let resumeValidator: ResumeValidator | null = null;
  let resumeIdentity: { device: bigint; inode: bigint } | null = null;
  if (download.bytes_downloaded > 0 && existsSync(partialPath)) {
    try {
      const restored = restorePartialCheckpoint(partialPath, download, model);
      resumeFrom = restored.resumeFrom;
      resumeValidator = restored.validator;
      resumeIdentity = { device: restored.device, inode: restored.inode };
    } catch {
      await modelDownloadRepository.transitionStatus(
        download.id,
        ["pending", "paused"],
        "failed",
        {
          error:
            "[resume_state_mismatch] Partial file, database and HTTP validator did not agree",
        },
      );
      return;
    }
  } else if (existsSync(partialPath)) {
    try {
      unlinkSync(partialPath);
    } catch {
      /* best effort */
    }
    try {
      unlinkSync(partialStatePath(partialPath));
    } catch {
      /* best effort */
    }
  }

  const controller = handle.controller;
  armInactivityTimer(handle, dependencies.inactivityTimeoutMs);
  let acquired = false;
  let out: FileHandle | null = null;
  let totalBytes = resumeFrom;
  let durableBytes = resumeFrom;
  let responseValidator: ResumeValidator | null = resumeValidator;
  let releaseTransfer: (() => Promise<void>) | null = null;
  let phase: ModelDownloadRow["status"] = "downloading";
  try {
    acquired = true;
    acquired = await modelDownloadRepository.transitionStatus(
      download.id,
      ["pending", "paused"],
      "downloading",
      {
        bytesDownloaded: resumeFrom,
      },
    );
    if (!acquired) return;

    if (resumeFrom < model.exactBytes) {
      const fetched = await dependencies.fetchArtifact(
        model,
        resumeFrom,
        resumeValidator,
        controller.signal,
      );
      const response = fetched.response;
      releaseTransfer = fetched.release ?? null;
      responseValidator = fetched.validator;
      if (response.body === null) {
        throw new ArtifactTransferError(
          "source_unavailable",
          "Artifact response had no body",
        );
      }

      writePartialState(partialStatePath(partialPath), {
        schemaVersion: 1,
        modelId: model.id,
        revision: model.source.revision,
        sourceUrl: model.source.downloadUrl,
        exactBytes: model.exactBytes,
        bytesDownloaded: resumeFrom,
        validator: responseValidator,
      });

      const noFollow = constants.O_NOFOLLOW ?? 0;
      const flags =
        resumeFrom > 0
          ? constants.O_WRONLY | constants.O_APPEND | noFollow
          : constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            noFollow;
      out = await dependencies.openPartial(partialPath, flags, 0o600);
      const opened = await out.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        Number(opened.size) !== resumeFrom ||
        (resumeIdentity !== null &&
          (opened.dev !== resumeIdentity.device ||
            opened.ino !== resumeIdentity.inode))
      ) {
        throw new ArtifactTransferError(
          "resume_state_mismatch",
          "Partial artifact changed before secure open",
        );
      }
      const nodeStream = Readable.fromWeb(
        response.body as Parameters<typeof Readable.fromWeb>[0],
      );
      const PROGRESS_FLUSH_BYTES = 16 * 1024 * 1024;
      let bytesSinceFlush = 0;
      for await (const value of nodeStream) {
        armInactivityTimer(handle, dependencies.inactivityTimeoutMs);
        const chunk = value as Buffer;
        if (totalBytes + chunk.length > model.exactBytes) {
          throw new ArtifactTransferError(
            "unexpected_length",
            "Artifact body exceeded exact registry size",
          );
        }
        await out.write(chunk);
        totalBytes += chunk.length;
        bytesSinceFlush += chunk.length;
        if (bytesSinceFlush >= PROGRESS_FLUSH_BYTES) {
          bytesSinceFlush = 0;
          if (
            !(await commitDurableCheckpoint({
              out,
              partialPath,
              downloadId: download.id,
              model,
              bytesDownloaded: totalBytes,
              validator: responseValidator,
            }))
          ) {
            throw new ArtifactTransferError(
              "cancelled",
              "Download state changed during transfer",
            );
          }
          durableBytes = totalBytes;
        }
      }
      if (
        !(await commitDurableCheckpoint({
          out,
          partialPath,
          downloadId: download.id,
          model,
          bytesDownloaded: totalBytes,
          validator: responseValidator,
        }))
      ) {
        throw new ArtifactTransferError(
          "cancelled",
          "Download state changed before verification",
        );
      }
      durableBytes = totalBytes;
      await out.close();
      out = null;
      if (releaseTransfer !== null) {
        await releaseTransfer();
        releaseTransfer = null;
      }
    }

    clearInactivityTimer(handle);
    if (handle.paused)
      throw new ArtifactTransferError("cancelled", "Download was paused");
    if (handle.cancelled) return;
    if (totalBytes !== model.exactBytes) {
      throw new ArtifactTransferError(
        "unexpected_length",
        `expected ${model.exactBytes} bytes, got ${totalBytes}`,
      );
    }
    if (
      !(await modelDownloadRepository.transitionStatus(
        download.id,
        ["downloading"],
        "verifying",
        {
          bytesDownloaded: totalBytes,
        },
      ))
    )
      return;
    phase = "verifying";

    const expectedHash = model.sha256.toLowerCase();
    const actual = await dependencies.hashFile(partialPath);
    if (handle.cancelled) return;
    if (handle.paused)
      throw new ArtifactTransferError(
        "cancelled",
        "Download was paused during verification",
      );
    if (actual !== expectedHash) {
      try {
        unlinkSync(partialPath);
      } catch {
        /* best effort */
      }
      try {
        unlinkSync(partialStatePath(partialPath));
      } catch {
        /* best effort */
      }
      await modelDownloadRepository.transitionStatus(
        download.id,
        ["verifying"],
        "failed",
        {
          error: `sha256 mismatch: expected ${expectedHash}, got ${actual}`,
          bytesDownloaded: 0,
        },
      );
      return;
    }

    if (
      !(await modelDownloadRepository.transitionStatus(
        download.id,
        ["verifying"],
        "installing",
      ))
    )
      return;
    phase = "installing";
    await dependencies.activate(modelDir, partialPath, model);
    try {
      unlinkSync(partialStatePath(partialPath));
    } catch {
      /* best effort */
    }
    if (
      !(await modelDownloadRepository.transitionStatus(
        download.id,
        ["installing"],
        "complete",
      ))
    ) {
      throw new Error("completion state transition failed");
    }
    log.info("Model download complete", {
      downloadId: download.id,
      modelId: download.model_id,
    });
  } catch (err) {
    if (
      out !== null &&
      responseValidator !== null &&
      totalBytes > durableBytes &&
      !handle.cancelled &&
      phase === "downloading"
    ) {
      try {
        if (
          await commitDurableCheckpoint({
            out,
            partialPath,
            downloadId: download.id,
            model,
            bytesDownloaded: totalBytes,
            validator: responseValidator,
          })
        )
          durableBytes = totalBytes;
      } catch (checkpointError) {
        log.warn("failed to advance durable model checkpoint", {
          downloadId: download.id,
          error:
            checkpointError instanceof Error
              ? checkpointError.message
              : String(checkpointError),
        });
      }
    }
    if (handle.cancelled || !acquired) return;
    const error = runnerError(err, handle.timedOut);
    if (
      handle.paused ||
      isResumableInterruption(err, handle, phase, durableBytes)
    ) {
      await modelDownloadRepository.transitionStatus(
        download.id,
        [phase],
        "paused",
        {
          bytesDownloaded: durableBytes,
          ...(handle.paused ? {} : { error }),
        },
      );
      return;
    }
    await modelDownloadRepository.transitionStatus(
      download.id,
      ["downloading", "verifying", "installing"],
      "failed",
      { error, bytesDownloaded: durableBytes },
    );
  } finally {
    if (releaseTransfer !== null) {
      try {
        await releaseTransfer();
      } catch {
        /* transfer already failed; release is best effort */
      }
    }
    if (out !== null) {
      try {
        await out.close();
      } catch (closeError) {
        log.warn("failed to close model partial", {
          downloadId: download.id,
          error:
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        });
      }
    }
    if (handle.cancelled) {
      try {
        if (existsSync(partialPath)) unlinkSync(partialPath);
      } catch {
        /* best effort after close */
      }
      try {
        const statePath = partialStatePath(partialPath);
        if (existsSync(statePath)) unlinkSync(statePath);
      } catch {
        /* best effort after close */
      }
    }
  }
}

/**
 * Boot-time recovery. Transfer/hash workers become resumable. Installation is
 * reconciled against the verified active manifest and never inferred merely
 * from a file's presence.
 */
export interface DownloadRecoveryDependencies {
  inspectActive: (modelDir: string | null) => ManagedModelInspection;
  modelDir: () => string;
}

const DEFAULT_RECOVERY_DEPENDENCIES: DownloadRecoveryDependencies = {
  inspectActive: inspectManagedActiveModel,
  modelDir: resolveModelDir,
};

export async function recoverOnBoot(
  dependencies: DownloadRecoveryDependencies = DEFAULT_RECOVERY_DEPENDENCIES,
): Promise<void> {
  try {
    const orphaned = await modelDownloadRepository.listWorkerOwnedNonterminal();
    let recovered = 0;
    for (const row of orphaned) {
      try {
        if (row.status === "downloading" || row.status === "verifying") {
          if (
            await modelDownloadRepository.transitionStatus(
              row.id,
              [row.status],
              "paused",
              { bytesDownloaded: row.bytes_downloaded },
            )
          )
            recovered += 1;
          continue;
        }

        const active = dependencies.inspectActive(dependencies.modelDir());
        const installed =
          active.state === "verified" &&
          active.model.id === row.model_id &&
          active.path === row.target_path &&
          active.manifest.sha256 === row.sha256_expected;
        if (installed) {
          if (
            await modelDownloadRepository.transitionStatus(
              row.id,
              ["installing"],
              "complete",
              { bytesDownloaded: row.total_bytes },
            )
          )
            recovered += 1;
        } else if (
          await modelDownloadRepository.transitionStatus(
            row.id,
            ["installing"],
            "failed",
            {
              error:
                "[install_recovery_failed] No matching verified active manifest; retry installation",
            },
          )
        )
          recovered += 1;
      } catch (error) {
        // One malformed path/row or one failed CAS must not strand every later
        // worker-owned row during startup reconciliation.
        log.warn("Failed to reconcile orphaned model download row", {
          downloadId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (recovered > 0) {
      log.info("Reconciled orphaned model download workers", {
        count: recovered,
      });
    }
  } catch (err) {
    // Don't crash the API if recovery fails — just log.
    log.warn("Failed to recover orphaned downloads", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
