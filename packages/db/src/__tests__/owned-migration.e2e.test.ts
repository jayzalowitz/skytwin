/**
 * Empty-store regression for the packaged desktop migration handoff.
 *
 * Run with a real CockroachDB binary:
 *   E2E=true COCKROACH_BINARY=/path/to/cockroach \
 *     pnpm --filter @skytwin/db exec vitest run src/__tests__/owned-migration.e2e.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { upOwned } from "../migrations/001-initial.js";
import {
  closePool,
  query,
  setWorkerGenerationAuthorityLossHandler,
  withTransaction,
  WorkerGenerationAuthorityError,
} from "../connection.js";
import { revokeWorkerGenerationAuthority } from "../worker-generation-authority.js";

const COCKROACH_BINARY = process.env["COCKROACH_BINARY"];
const RUN_E2E = process.env["E2E"] === "true" && Boolean(COCKROACH_BINARY);

async function reservePorts(): Promise<[number, number]> {
  const servers = [createServer(), createServer()];
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        }),
    ),
  );
  const ports = servers.map((server) => {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("failed to reserve CockroachDB test port");
    return address.port;
  }) as [number, number];
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  return ports;
}

async function waitForSql(connectionString: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 500,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    "CockroachDB did not become ready for empty-store migration test",
  );
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe.skipIf(!RUN_E2E)(
  "E2E: owned migration on an empty CockroachDB store",
  () => {
    let child: ChildProcess;
    let dataRoot: string;
    let targetUrl: string;

    beforeAll(async () => {
      const [sqlPort, httpPort] = await reservePorts();
      dataRoot = mkdtempSync(join(tmpdir(), "skytwin-owned-migration-"));
      targetUrl = `postgresql://root@127.0.0.1:${sqlPort}/skytwin?sslmode=disable`;
      child = spawn(
        COCKROACH_BINARY!,
        [
          "start-single-node",
          "--insecure",
          `--listen-addr=127.0.0.1:${sqlPort}`,
          `--http-addr=127.0.0.1:${httpPort}`,
          `--store=${join(dataRoot, "store")}`,
          `--log-dir=${join(dataRoot, "logs")}`,
        ],
        { stdio: "ignore" },
      );
      await waitForSql(
        `postgresql://root@127.0.0.1:${sqlPort}/defaultdb?sslmode=disable`,
      );
    }, 70_000);

    afterAll(async () => {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        if (!(await waitForExit(child, 30_000))) {
          child.kill("SIGKILL");
          await waitForExit(child, 5_000);
        }
      }
      if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
    }, 35_000);

    it("creates the target database and applies the complete migration corpus on one target connection", async () => {
      await upOwned({
        connectionString: targetUrl,
        authorize: () => child.exitCode === null,
      });

      const client = new Client({
        connectionString: targetUrl,
        connectionTimeoutMillis: 5_000,
      });
      await client.connect();
      try {
        const users = await client.query<{ table_name: string }>(
          `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('users', 'twin_profiles', 'watch_runs', 'worker_generation_authority')
          ORDER BY table_name`,
        );
        expect(users.rows.map((row) => row.table_name)).toEqual([
          "twin_profiles",
          "users",
          "watch_runs",
          "worker_generation_authority",
        ]);
      } finally {
        await client.end();
      }
    }, 300_000);

    it("serializes revocation with an in-flight fenced write and rejects the next write", async () => {
      const generationId = "93c89fcc-2fa4-49a4-8510-171193973983";
      const secretHash = "b".repeat(64);
      const setup = new Client({ connectionString: targetUrl });
      await setup.connect();
      await setup.query(
        `CREATE TABLE IF NOT EXISTS worker_generation_fence_probe (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           value STRING NOT NULL
         )`,
      );
      await setup.query(
        `INSERT INTO worker_generation_authority (id, secret_hash, active)
         VALUES ($1, $2, true)
         ON CONFLICT (id) DO UPDATE SET secret_hash = excluded.secret_hash, active = true`,
        [generationId, secretHash],
      );
      await setup.end();

      const worker = new Client({ connectionString: targetUrl });
      const revoker = new Client({ connectionString: targetUrl });
      await Promise.all([worker.connect(), revoker.connect()]);
      try {
        await worker.query("BEGIN");
        const authorized = await worker.query(
          `SELECT id FROM worker_generation_authority
            WHERE id = $1 AND secret_hash = $2 AND active = true
            FOR UPDATE`,
          [generationId, secretHash],
        );
        expect(authorized.rowCount).toBe(1);
        await worker.query(
          "INSERT INTO worker_generation_fence_probe (value) VALUES ('before-revocation')",
        );

        let revocationCommitted = false;
        const revoke = revoker
          .query(
            `UPDATE worker_generation_authority
              SET active = false, revoked_at = now()
            WHERE id = $1 AND secret_hash = $2 AND active = true`,
            [generationId, secretHash],
          )
          .then(() => {
            revocationCommitted = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(revocationCommitted).toBe(false);

        await worker.query("COMMIT");
        await revoke;

        await worker.query("BEGIN");
        const stale = await worker.query(
          `SELECT id FROM worker_generation_authority
            WHERE id = $1 AND secret_hash = $2 AND active = true
            FOR UPDATE`,
          [generationId, secretHash],
        );
        expect(stale.rowCount).toBe(0);
        await worker.query("ROLLBACK");

        const writes = await revoker.query<{ value: string }>(
          "SELECT value FROM worker_generation_fence_probe ORDER BY value",
        );
        expect(writes.rows.map((row) => row.value)).toEqual([
          "before-revocation",
        ]);
      } finally {
        await worker.query("ROLLBACK").catch(() => undefined);
        await Promise.all([worker.end(), revoker.end()]);
      }
    }, 30_000);

    it("fences repository transactions and synchronously revokes admission after durable revocation", async () => {
      const generationId = "18c9b067-b50d-4abb-af80-ef38014d9615";
      const generationSecret = "c".repeat(64);
      const secretHash = createHash("sha256")
        .update(generationSecret)
        .digest("hex");
      const control = new Client({ connectionString: targetUrl });
      await control.connect();
      await control.query(
        `INSERT INTO worker_generation_authority (id, secret_hash, active)
         VALUES ($1, $2, true)
         ON CONFLICT (id) DO UPDATE SET secret_hash = excluded.secret_hash, active = true`,
        [generationId, secretHash],
      );
      process.env["DATABASE_URL"] = targetUrl;
      process.env["SKYTWIN_WORKER_GENERATION_ID"] = generationId;
      process.env["SKYTWIN_WORKER_GENERATION_SECRET"] = generationSecret;
      let releaseWrite: (() => void) | undefined;
      let writeStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        writeStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });

      try {
        const write = withTransaction(async (client) => {
          await client.query(
            "INSERT INTO worker_generation_fence_probe (value) VALUES ('repository-write')",
          );
          writeStarted?.();
          await release;
        });
        await started;

        let revocationCommitted = false;
        const revoke = control
          .query(
            `UPDATE worker_generation_authority
                SET active = false, revoked_at = now()
              WHERE id = $1 AND secret_hash = $2 AND active = true`,
            [generationId, secretHash],
          )
          .then(() => {
            revocationCommitted = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(revocationCommitted).toBe(false);
        releaseWrite?.();
        await write;
        await revoke;

        const onLoss = vi.fn();
        setWorkerGenerationAuthorityLossHandler(onLoss);
        await expect(
          query(
            "INSERT INTO worker_generation_fence_probe (value) VALUES ('after-revocation')",
          ),
        ).rejects.toBeInstanceOf(WorkerGenerationAuthorityError);
        expect(onLoss).toHaveBeenCalledOnce();

        const values = await control.query<{ value: string }>(
          "SELECT value FROM worker_generation_fence_probe ORDER BY value",
        );
        expect(values.rows.map((row) => row.value)).not.toContain(
          "after-revocation",
        );
      } finally {
        releaseWrite?.();
        setWorkerGenerationAuthorityLossHandler(null);
        delete process.env["SKYTWIN_WORKER_GENERATION_ID"];
        delete process.env["SKYTWIN_WORKER_GENERATION_SECRET"];
        delete process.env["DATABASE_URL"];
        await closePool();
        await control.end();
      }
    }, 30_000);

    it("rejects reconciliation against the same generation ID with a different secret", async () => {
      const generationId = "bd21266c-b62a-4ada-ae0a-8a18b4c285eb";
      const storedHash = createHash("sha256")
        .update("d".repeat(64))
        .digest("hex");
      const control = new Client({ connectionString: targetUrl });
      await control.connect();
      try {
        await control.query(
          `INSERT INTO worker_generation_authority (id, secret_hash, active)
           VALUES ($1, $2, true)`,
          [generationId, storedHash],
        );

        await expect(
          revokeWorkerGenerationAuthority({
            connectionString: targetUrl,
            generationId,
            generationSecret: "e".repeat(64),
            authorize: () => true,
          }),
        ).rejects.toThrow(/could not be revoked exactly/);

        const retained = await control.query<{
          secret_hash: string;
          active: boolean;
        }>(
          `SELECT secret_hash, active
             FROM worker_generation_authority
            WHERE id = $1`,
          [generationId],
        );
        expect(retained.rows).toEqual([
          { secret_hash: storedHash, active: true },
        ]);
      } finally {
        await control.end();
      }
    }, 30_000);
  },
);
