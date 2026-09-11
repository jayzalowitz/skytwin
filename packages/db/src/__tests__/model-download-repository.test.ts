import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("../connection.js", () => ({ query: queryMock }));

import { modelDownloadRepository } from "../repositories/model-download-repository.js";

beforeEach(() => {
  queryMock.mockReset();
});

describe("model download compare-and-set updates", () => {
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
      "status IN ('downloading', 'verifying', 'installing')",
    );
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
