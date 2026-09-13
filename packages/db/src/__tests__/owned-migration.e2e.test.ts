/**
 * Empty-store regression for the packaged desktop migration handoff.
 *
 * Run with a real CockroachDB binary:
 *   E2E=true COCKROACH_BINARY=/path/to/cockroach \
 *     pnpm --filter @skytwin/db exec vitest run src/__tests__/owned-migration.e2e.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upOwned } from "../migrations/001-initial.js";

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
            AND table_name IN ('users', 'twin_profiles', 'watch_runs')
          ORDER BY table_name`,
        );
        expect(users.rows.map((row) => row.table_name)).toEqual([
          "twin_profiles",
          "users",
          "watch_runs",
        ]);
      } finally {
        await client.end();
      }
    }, 300_000);
  },
);
