import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("../connection.js", () => ({ query: queryMock }));

import { modelDownloadRepository } from "../repositories/model-download-repository.js";

beforeEach(() => {
  queryMock.mockReset();
});

describe("model download compare-and-set updates", () => {
  it("normalizes CockroachDB INT8 byte strings before callers resume", async () => {
    queryMock.mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: "id",
        user_id: "user-id",
        model_id: "model-id",
        target_path: "/models/model.gguf",
        total_bytes: "1117320736",
        bytes_downloaded: "16777216",
        sha256_expected: "a".repeat(64),
        status: "paused",
        error: null,
        started_at: new Date(),
        paused_at: new Date(),
        completed_at: null,
      }],
    });
    const row = await modelDownloadRepository.findById("id");
    expect(row?.total_bytes).toBe(1_117_320_736);
    expect(row?.bytes_downloaded).toBe(16_777_216);
    expect(typeof row?.bytes_downloaded).toBe("number");
  });

  it.each(["01", "-1", "1.5", "9007199254740992"])(
    "rejects unsafe or non-canonical CockroachDB INT8 bytes %s",
    async (bytesDownloaded) => {
      queryMock.mockResolvedValue({
        rowCount: 1,
        rows: [{
          id: "id",
          user_id: "user-id",
          model_id: "model-id",
          target_path: "/models/model.gguf",
          total_bytes: "1117320736",
          bytes_downloaded: bytesDownloaded,
          sha256_expected: "a".repeat(64),
          status: "paused",
          error: null,
          started_at: new Date(),
          paused_at: new Date(),
          completed_at: null,
        }],
      });
      await expect(modelDownloadRepository.findById("id")).rejects.toThrow(
        /model_downloads/,
      );
    },
  );

  it("checkpoints progress only while the owning runner is downloading", async () => {
    queryMock.mockResolvedValue({ rowCount: 1, rows: [] });
    await expect(
      modelDownloadRepository.checkpointProgress("id", 42),
    ).resolves.toBe(true);
    expect(queryMock.mock.calls[0]![0]).toContain("status = 'downloading'");
  });

  it("guards terminal transitions by the expected prior state", async () => {
    queryMock.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(
      modelDownloadRepository.transitionStatus(
        "id",
        ["installing"],
        "complete",
      ),
    ).resolves.toBe(false);
    expect(queryMock.mock.calls[0]![0]).toContain("status = ANY");
    expect(queryMock.mock.calls[0]![1]).toEqual([
      "id",
      "complete",
      ["installing"],
    ]);
  });

  it("clears stale interruption errors when resuming or completing", async () => {
    queryMock.mockResolvedValue({ rowCount: 1, rows: [] });
    await modelDownloadRepository.transitionStatus(
      "id",
      ["paused"],
      "downloading",
    );
    expect(queryMock.mock.calls[0]![0]).toContain("error = NULL");
    await modelDownloadRepository.transitionStatus(
      "id",
      ["installing"],
      "complete",
    );
    expect(queryMock.mock.calls[1]![0]).toContain("error = NULL");
  });

  it("lists every worker-owned nonterminal state for boot reconciliation", async () => {
    queryMock.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(
      modelDownloadRepository.listWorkerOwnedNonterminal(),
    ).resolves.toEqual([]);
    expect(queryMock.mock.calls[0]![0]).toContain(
      "status IN ('pending', 'downloading', 'verifying', 'installing')",
    );
  });

  it("isolates a malformed recovery row and returns the later valid row", async () => {
    const base = {
      user_id: "user-id",
      model_id: "model-id",
      target_path: "/models/model.gguf",
      total_bytes: "1117320736",
      sha256_expected: "a".repeat(64),
      status: "pending",
      error: null,
      started_at: new Date(),
      paused_at: null,
      completed_at: null,
    };
    queryMock.mockResolvedValue({
      rowCount: 2,
      rows: [
        { ...base, id: "malformed-first", bytes_downloaded: "unsafe" },
        { ...base, id: "later-valid", bytes_downloaded: "0" },
      ],
    });

    await expect(modelDownloadRepository.listWorkerOwnedNonterminal())
      .resolves.toEqual([
        expect.objectContaining({
          id: "later-valid",
          total_bytes: 1_117_320_736,
          bytes_downloaded: 0,
        }),
      ]);
  });

  it("bulk recovery keeps both transfer and verification resumable", async () => {
    queryMock.mockResolvedValue({ rowCount: 2, rows: [] });
    await expect(
      modelDownloadRepository.recoverOrphanedDownloads(),
    ).resolves.toBe(2);
    expect(queryMock.mock.calls[0]![0]).toContain(
      "status IN ('downloading', 'verifying')",
    );
  });
});
