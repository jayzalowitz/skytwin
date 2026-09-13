/**
 * Real CockroachDB coverage for INT8 decoding on resumable model downloads.
 *
 * Run via:
 *   E2E=true pnpm --filter @skytwin/db exec vitest run src/__tests__/model-download-repository.e2e.test.ts
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../connection.js";
import { modelDownloadRepository } from "../repositories/model-download-repository.js";

const E2E = process.env["E2E"] === "true";
let userId: string | null = null;

describe.skipIf(!E2E)("E2E: model download INT8 normalization", () => {
  beforeAll(async () => {
    await getPool().query("SELECT 1");
  });

  afterEach(async () => {
    if (userId !== null) {
      await getPool().query("DELETE FROM users WHERE id = $1", [userId]);
      userId = null;
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it("normalizes real Cockroach INT8 strings before a paused download resumes", async () => {
    const owner = await getPool().query<{ id: string }>(
      `INSERT INTO users (email, name, trust_tier, autonomy_settings)
       VALUES ($1, 'Model Download INT8 E2E', 'observer', '{}')
       RETURNING id`,
      [`model-download-${randomUUID()}@example.test`],
    );
    userId = owner.rows[0]!.id;

    const totalBytes = 4_294_967_296;
    const bytesDownloaded = 16_777_216;
    const created = await modelDownloadRepository.create({
      userId,
      modelId: `e2e-${randomUUID()}`,
      targetPath: "/private/model-download-e2e.gguf",
      totalBytes,
      sha256Expected: "a".repeat(64),
    });
    await modelDownloadRepository.setStatus(created.id, "paused", {
      bytesDownloaded,
    });

    const raw = await getPool().query<{
      total_bytes: string;
      bytes_downloaded: string;
    }>(
      `SELECT total_bytes, bytes_downloaded
         FROM model_downloads
        WHERE id = $1`,
      [created.id],
    );
    expect(raw.rows[0]).toMatchObject({
      total_bytes: String(totalBytes),
      bytes_downloaded: String(bytesDownloaded),
    });

    const resumable = await modelDownloadRepository.findById(created.id);
    expect(resumable).toMatchObject({
      status: "paused",
      total_bytes: totalBytes,
      bytes_downloaded: bytesDownloaded,
    });
    expect(typeof resumable?.total_bytes).toBe("number");
    expect(typeof resumable?.bytes_downloaded).toBe("number");
  });
});
