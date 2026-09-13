import { createHash } from "node:crypto";
import {
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  managedArtifactPath,
  MODEL_REGISTRY,
  type ModelEntry,
} from "@skytwin/embedded-llm";

const mockRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  findActive: vi.fn(),
  create: vi.fn(),
  transitionStatus: vi.fn(),
  checkpointProgress: vi.fn(),
  listWorkerOwnedNonterminal: vi.fn(),
}));

vi.mock("@skytwin/db", () => ({ modelDownloadRepository: mockRepo }));

import {
  pauseDownload,
  recoverOnBoot,
  runDownload,
  startDownload,
  type DownloadRunnerDependencies,
} from "../downloader.js";

const dirs: string[] = [];
const bytes = Buffer.from("test");
const digest = createHash("sha256").update(bytes).digest("hex");
let currentStatus = "pending";

function testModel(): ModelEntry {
  return {
    ...MODEL_REGISTRY[0]!,
    approxBytes: bytes.length,
    exactBytes: bytes.length,
    minimumRamBytes: bytes.length,
    sha256: digest,
  };
}

function testRow(
  dir: string,
  status:
    | "pending"
    | "paused"
    | "downloading"
    | "verifying"
    | "installing" = "pending",
) {
  return {
    id: "download-id",
    user_id: "user-id",
    model_id: testModel().id,
    target_path: managedArtifactPath(dir, testModel()),
    total_bytes: bytes.length,
    bytes_downloaded:
      status === "paused" || status === "verifying" || status === "installing"
        ? bytes.length
        : 0,
    sha256_expected: digest,
    status,
    error: null,
    started_at: new Date(),
    paused_at: null,
    completed_at: null,
  } as const;
}

function dependencies(
  overrides: Partial<DownloadRunnerDependencies> = {},
): DownloadRunnerDependencies {
  const model = testModel();
  return {
    findModel: () => model,
    fetchArtifact: vi.fn().mockResolvedValue({
      response: new Response(bytes),
      finalUrl: model.source.downloadUrl,
      validator: { etag: '"pinned"' },
    }),
    hashFile: vi.fn().mockResolvedValue(digest),
    activate: vi.fn(),
    refreshRuntime: vi.fn(),
    openPartial: open,
    modelDir: () => "/tmp",
    inactivityTimeoutMs: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentStatus = "pending";
  mockRepo.findById.mockImplementation(async () => ({
    ...testRow("/tmp"),
    status: currentStatus,
  }));
  mockRepo.transitionStatus.mockImplementation(
    async (_id: string, expected: readonly string[], status: string) => {
      if (!expected.includes(currentStatus)) return false;
      currentStatus = status;
      return true;
    },
  );
  mockRepo.checkpointProgress.mockResolvedValue(true);
  mockRepo.listWorkerOwnedNonterminal.mockResolvedValue([]);
  mockRepo.findActive.mockResolvedValue(null);
});

describe("download runner ownership", () => {
  it("claims a row before its first await so concurrent launches share one runner", async () => {
    const dir = tempDir();
    const row = testRow(dir);
    let releaseLookup!: () => void;
    const lookupBarrier = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    mockRepo.findById.mockImplementationOnce(async () => {
      await lookupBarrier;
      return row;
    });
    const deps = dependencies({ modelDir: () => dir });
    const first = runDownload(row, deps);
    const second = runDownload(row, deps);
    releaseLookup();
    await Promise.all([first, second]);

    expect(mockRepo.findById).toHaveBeenCalledTimes(1);
    expect(deps.fetchArtifact).toHaveBeenCalledTimes(1);
  });

  it("does not truncate an active runner's crash tail on duplicate start", async () => {
    const dir = tempDir();
    vi.stubEnv("SKYTWIN_LLAMA_MODELS", dir);
    const model = MODEL_REGISTRY[0]!;
    const targetPath = managedArtifactPath(dir, model);
    const row = {
      id: "active-download-id",
      user_id: "user-id",
      model_id: model.id,
      target_path: targetPath,
      total_bytes: model.exactBytes,
      bytes_downloaded: 4,
      sha256_expected: model.sha256,
      status: "paused" as const,
      error: null,
      started_at: new Date(),
      paused_at: new Date(),
      completed_at: null,
    };
    const partial = `${targetPath}.${row.id}.partial`;
    writeFileSync(partial, "1234567");
    writeFileSync(
      `${partial}.json`,
      JSON.stringify({
        schemaVersion: 1,
        modelId: model.id,
        revision: model.source.revision,
        sourceUrl: model.source.downloadUrl,
        exactBytes: model.exactBytes,
        bytesDownloaded: 7,
        validator: { etag: '"pinned"' },
      }),
    );

    let releaseLookup!: () => void;
    const lookupBarrier = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    mockRepo.findById.mockImplementationOnce(async () => {
      await lookupBarrier;
      return { ...row, status: "cancelled" as const };
    });
    mockRepo.findActive.mockResolvedValue(row);

    const active = runDownload(
      row,
      dependencies({ findModel: () => model, modelDir: () => dir }),
    );
    await vi.waitFor(() => expect(mockRepo.findById).toHaveBeenCalledOnce());

    try {
      await expect(startDownload(row.user_id, row.model_id)).resolves.toEqual({
        download: row,
        resumed: true,
      });
      expect(statSync(partial).size).toBe(7);
    } finally {
      releaseLookup();
      await active;
    }
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skytwin-runner-"));
  dirs.push(dir);
  return dir;
}

describe("download runner cleanup and resumability", () => {
  it("fails a database row whose target is not the registry-derived managed path", async () => {
    const dir = tempDir();
    const row = { ...testRow(dir), target_path: join(dir, "unexpected.gguf") };
    await runDownload(row, dependencies({ modelDir: () => dir }));
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      row.id,
      ["pending", "paused"],
      "failed",
      expect.objectContaining({
        error: expect.stringContaining("[managed_path_mismatch]"),
      }),
    );
  });

  it("contains a post-acquire open failure, marks failed, and releases runner ownership", async () => {
    const dir = tempDir();
    const row = testRow(dir);
    const openFailure = vi.fn().mockRejectedValue(new Error("open failed"));
    const deps = dependencies({
      openPartial: openFailure as unknown as typeof open,
      modelDir: () => dir,
    });

    await runDownload(row, deps);
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      row.id,
      ["downloading", "verifying", "installing"],
      "failed",
      expect.objectContaining({
        error: "[download_io_error] Local model storage operation failed",
        bytesDownloaded: 0,
      }),
    );

    // A leaked in-flight handle would make the second runner impossible to own.
    currentStatus = "pending";
    await runDownload(row, deps);
    expect(
      mockRepo.transitionStatus.mock.calls.filter(
        (call) => call[2] === "downloading",
      ),
    ).toHaveLength(2);
  });

  it("does not advance the durable pause boundary when file sync fails", async () => {
    const dir = tempDir();
    const row = testRow(dir);
    let releaseWrite!: () => void;
    const wrote = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const fakeHandle = {
      write: vi.fn().mockImplementation(async () => {
        releaseWrite();
      }),
      sync: vi.fn().mockRejectedValue(new Error("fsync failed")),
      close: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({
        isFile: () => true,
        nlink: 1n,
        size: 0n,
        dev: 1n,
        ino: 1n,
      }),
    };
    const model = testModel();
    const fetchArtifact = vi
      .fn()
      .mockImplementation(
        async (
          _model: ModelEntry,
          _resume: number,
          _validator: unknown,
          signal: AbortSignal,
        ) => ({
          response: new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                signal.addEventListener(
                  "abort",
                  () => controller.error(new Error("aborted")),
                  { once: true },
                );
              },
            }),
          ),
          finalUrl: model.source.downloadUrl,
          validator: { etag: '"pinned"' },
        }),
      );
    const running = runDownload(
      row,
      dependencies({
        fetchArtifact,
        openPartial: vi
          .fn()
          .mockResolvedValue(fakeHandle) as unknown as typeof open,
        modelDir: () => dir,
      }),
    );
    await wrote;
    expect(await pauseDownload(row.id)).toBe(true);
    await running;

    expect(mockRepo.checkpointProgress).not.toHaveBeenCalled();
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      row.id,
      ["downloading"],
      "paused",
      { bytesDownloaded: 0 },
    );
  });

  it("turns a close failure after a committed full checkpoint into a resumable pause", async () => {
    const dir = tempDir();
    const row = testRow(dir);
    const partial = `${row.target_path}.${row.id}.partial`;
    const fakeHandle = {
      write: vi.fn().mockImplementation(async (chunk: Uint8Array) => {
        writeFileSync(partial, chunk);
      }),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockRejectedValue(new Error("close failed")),
      stat: vi.fn().mockResolvedValue({
        isFile: () => true,
        nlink: 1n,
        size: 0n,
        dev: 1n,
        ino: 1n,
      }),
    };
    await runDownload(
      row,
      dependencies({
        openPartial: vi
          .fn()
          .mockResolvedValue(fakeHandle) as unknown as typeof open,
        modelDir: () => dir,
      }),
    );
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      row.id,
      ["downloading"],
      "paused",
      expect.objectContaining({ bytesDownloaded: bytes.length }),
    );
  });

  it("uses an inactivity timeout and preserves a resumable paused state", async () => {
    const dir = tempDir();
    const row = testRow(dir);
    const model = testModel();
    const fetchArtifact = vi
      .fn()
      .mockImplementation(
        async (
          _model: ModelEntry,
          _resume: number,
          _validator: unknown,
          signal: AbortSignal,
        ) => ({
          response: new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                signal.addEventListener(
                  "abort",
                  () => controller.error(new Error("stalled")),
                  { once: true },
                );
              },
            }),
          ),
          finalUrl: model.source.downloadUrl,
          validator: { etag: '"pinned"' },
        }),
      );
    await runDownload(
      row,
      dependencies({
        fetchArtifact,
        inactivityTimeoutMs: 5,
        modelDir: () => dir,
      }),
    );
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      row.id,
      ["downloading"],
      "paused",
      expect.objectContaining({
        bytesDownloaded: 0,
        error: expect.stringContaining("[timeout]"),
      }),
    );
  });

  it("re-verifies a full-size recovered checkpoint without another network request", async () => {
    const dir = tempDir();
    const row = testRow(dir, "paused");
    const model = testModel();
    const partial = `${row.target_path}.${row.id}.partial`;
    writeFileSync(partial, bytes);
    writeFileSync(
      `${partial}.json`,
      JSON.stringify({
        schemaVersion: 1,
        modelId: model.id,
        revision: model.source.revision,
        sourceUrl: model.source.downloadUrl,
        exactBytes: model.exactBytes,
        bytesDownloaded: model.exactBytes,
        validator: { etag: '"pinned"' },
      }),
    );
    mockRepo.findById.mockResolvedValue(row);
    let status = "paused";
    mockRepo.transitionStatus.mockImplementation(
      async (_id: string, expected: readonly string[], next: string) => {
        if (!expected.includes(status)) return false;
        status = next;
        return true;
      },
    );
    const deps = dependencies({ modelDir: () => dir });
    await runDownload(row, deps);
    expect(deps.fetchArtifact).not.toHaveBeenCalled();
    expect(deps.hashFile).toHaveBeenCalledWith(partial);
    expect(deps.activate).toHaveBeenCalled();
    expect(deps.refreshRuntime).toHaveBeenCalledTimes(1);
    expect(status).toBe("complete");
  });

  it("rejects a resumed partial replaced between checkpoint restore and descriptor open", async () => {
    const dir = tempDir();
    const model = {
      ...testModel(),
      exactBytes: 8,
      approxBytes: 8,
      minimumRamBytes: 8,
      sha256: createHash("sha256").update("12345678").digest("hex"),
    };
    const row = {
      ...testRow(dir, "paused"),
      total_bytes: 8,
      bytes_downloaded: 4,
      target_path: managedArtifactPath(dir, model),
      sha256_expected: model.sha256,
    };
    const partial = `${row.target_path}.${row.id}.partial`;
    writeFileSync(partial, "1234");
    writeFileSync(
      `${partial}.json`,
      JSON.stringify({
        schemaVersion: 1,
        modelId: model.id,
        revision: model.source.revision,
        sourceUrl: model.source.downloadUrl,
        exactBytes: 8,
        bytesDownloaded: 4,
        validator: { etag: '"pinned"' },
      }),
    );
    mockRepo.findById.mockResolvedValue(row);
    currentStatus = "paused";
    const secureOpen = vi
      .fn()
      .mockImplementation(async (path: string, flags: number, mode: number) => {
        renameSync(path, `${path}.original`);
        writeFileSync(path, "xxxx");
        return open(path, flags, mode);
      });
    await runDownload(
      row,
      dependencies({
        findModel: () => model,
        fetchArtifact: vi.fn().mockResolvedValue({
          response: new Response("5678", { status: 206 }),
          finalUrl: model.source.downloadUrl,
          validator: { etag: '"pinned"' },
        }),
        openPartial: secureOpen as typeof open,
        modelDir: () => dir,
      }),
    );
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      row.id,
      ["downloading", "verifying", "installing"],
      "failed",
      expect.objectContaining({
        error: expect.stringContaining("Partial artifact changed"),
      }),
    );
  });
});

describe("boot recovery", () => {
  it("pauses orphaned transfer/hash rows and reconciles installation only from a verified manifest", async () => {
    const dir = tempDir();
    const downloading = testRow(dir, "downloading");
    const verifying = { ...testRow(dir, "verifying"), id: "verify-id" };
    const installing = { ...testRow(dir, "installing"), id: "install-id" };
    mockRepo.listWorkerOwnedNonterminal
      .mockResolvedValueOnce([downloading, verifying, installing])
      .mockResolvedValueOnce([]);
    mockRepo.transitionStatus.mockResolvedValue(true);
    await recoverOnBoot({
      modelDir: () => dir,
      inspectActive: () => ({
        state: "verified",
        path: installing.target_path,
        manifest: {
          schemaVersion: 1,
          modelId: installing.model_id,
          registryVersion: 1,
          revision: testModel().source.revision,
          filename: "model.gguf",
          exactBytes: bytes.length,
          sha256: digest,
          sourceUrl: testModel().source.downloadUrl,
          licenseSpdxId: testModel().license.spdxId,
          verifiedAt: new Date().toISOString(),
        },
        model: testModel(),
      }),
    });
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      downloading.id,
      ["downloading"],
      "paused",
      { bytesDownloaded: downloading.bytes_downloaded },
    );
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      verifying.id,
      ["verifying"],
      "paused",
      { bytesDownloaded: verifying.bytes_downloaded },
    );
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      installing.id,
      ["installing"],
      "complete",
      { bytesDownloaded: installing.total_bytes },
    );
  });

  it("fails an orphaned install when no matching verified active manifest exists", async () => {
    const dir = tempDir();
    const installing = testRow(dir, "installing");
    mockRepo.listWorkerOwnedNonterminal
      .mockResolvedValueOnce([installing])
      .mockResolvedValueOnce([]);
    mockRepo.transitionStatus.mockResolvedValue(true);
    await recoverOnBoot({
      modelDir: () => dir,
      inspectActive: () => ({ state: "missing" }),
    });
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      installing.id,
      ["installing"],
      "failed",
      expect.objectContaining({
        error: expect.stringContaining("[install_recovery_failed]"),
      }),
    );
  });

  it("isolates malformed-row recovery failures and continues with later rows", async () => {
    const dir = tempDir();
    const malformed = testRow(dir, "installing");
    const later = { ...testRow(dir, "downloading"), id: "later-id" };
    mockRepo.listWorkerOwnedNonterminal
      .mockResolvedValueOnce([malformed, later])
      .mockResolvedValueOnce([malformed]);
    mockRepo.transitionStatus.mockResolvedValue(true);
    await expect(
      recoverOnBoot({
        modelDir: () => dir,
        inspectActive: () => {
          throw new Error("malformed manifest row");
        },
        maxAttempts: 1,
      }),
    ).rejects.toThrow(/left 1 worker-owned row/);
    expect(mockRepo.transitionStatus).toHaveBeenCalledWith(
      later.id,
      ["downloading"],
      "paused",
      { bytesDownloaded: later.bytes_downloaded },
    );
  });

  it("retries a transient initial authoritative query failure", async () => {
    mockRepo.listWorkerOwnedNonterminal
      .mockRejectedValueOnce(new Error("recovery database unavailable"))
      .mockResolvedValueOnce([]);
    const wait = vi.fn().mockResolvedValue(undefined);

    await recoverOnBoot({
      modelDir: () => "/tmp",
      inspectActive: () => ({ state: "missing" }),
      maxAttempts: 2,
      retryDelayMs: 0,
      wait,
    });

    expect(wait).toHaveBeenCalledTimes(1);
    expect(mockRepo.listWorkerOwnedNonterminal).toHaveBeenCalledTimes(2);
  });

  it("retries a transient final authoritative query failure", async () => {
    const row = testRow("/tmp", "downloading");
    mockRepo.listWorkerOwnedNonterminal
      .mockResolvedValueOnce([row])
      .mockRejectedValueOnce(new Error("reconciliation read unavailable"))
      .mockResolvedValueOnce([]);
    const wait = vi.fn().mockResolvedValue(undefined);

    await recoverOnBoot({
      modelDir: () => "/tmp",
      inspectActive: () => ({ state: "missing" }),
      maxAttempts: 2,
      retryDelayMs: 0,
      wait,
    });

    expect(wait).toHaveBeenCalledTimes(1);
    expect(mockRepo.listWorkerOwnedNonterminal).toHaveBeenCalledTimes(3);
  });

  it.each(["initial", "final"] as const)(
    "fails closed after exhausting %s authoritative query retries",
    async (phase) => {
      const failure = new Error(`${phase} recovery database unavailable`);
      const row = testRow("/tmp", "downloading");
      if (phase === "initial") {
        mockRepo.listWorkerOwnedNonterminal.mockRejectedValue(failure);
      } else {
        mockRepo.listWorkerOwnedNonterminal
          .mockResolvedValueOnce([row])
          .mockRejectedValueOnce(failure)
          .mockResolvedValueOnce([row])
          .mockRejectedValueOnce(failure);
      }
      const wait = vi.fn().mockResolvedValue(undefined);

      await expect(
        recoverOnBoot({
          modelDir: () => "/tmp",
          inspectActive: () => ({ state: "missing" }),
          maxAttempts: 2,
          retryDelayMs: 0,
          wait,
        }),
      ).rejects.toThrow(failure.message);

      expect(wait).toHaveBeenCalledTimes(1);
      expect(mockRepo.listWorkerOwnedNonterminal).toHaveBeenCalledTimes(
        phase === "initial" ? 2 : 4,
      );
    },
  );

  it("retries an unresolved row within a fixed bound and verifies DB authority", async () => {
    const dir = tempDir();
    const row = testRow(dir, "downloading");
    mockRepo.listWorkerOwnedNonterminal
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([]);
    mockRepo.transitionStatus
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const wait = vi.fn().mockResolvedValue(undefined);

    await recoverOnBoot({
      modelDir: () => dir,
      inspectActive: () => ({ state: "missing" }),
      maxAttempts: 2,
      retryDelayMs: 0,
      wait,
    });

    expect(wait).toHaveBeenCalledTimes(1);
    expect(mockRepo.transitionStatus).toHaveBeenCalledTimes(2);
    expect(mockRepo.listWorkerOwnedNonterminal).toHaveBeenCalledTimes(4);
  });
});
