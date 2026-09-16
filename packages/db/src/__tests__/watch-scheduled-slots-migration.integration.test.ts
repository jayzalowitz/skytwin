import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

const cockroachAvailable =
  spawnSync("cockroach", ["version"], { encoding: "utf8" }).status === 0;

async function availablePorts(): Promise<[number, number]> {
  const reserve = (start: number) =>
    new Promise<{ server: ReturnType<typeof createServer>; port: number }>(
      (resolve, reject) => {
        const tryPort = (port: number) => {
          const server = createServer();
          server.once("error", (error: NodeJS.ErrnoException) => {
            server.close();
            if (error.code === "EADDRINUSE" && port < start + 1_000)
              tryPort(port + 1);
            else reject(error);
          });
          server.listen(port, "127.0.0.1", () => resolve({ server, port }));
        };
        tryPort(start);
      },
    );
  // Cockroach demo derives an advertise port from the SQL port, so keep the
  // dynamically probed SQL range well below 65535.
  const sql = await reserve(20_000 + (process.pid % 5_000));
  const http = await reserve(40_000 + (process.pid % 5_000));
  await Promise.all([
    new Promise<void>((resolve, reject) =>
      sql.server.close((error) => (error ? reject(error) : resolve())),
    ),
    new Promise<void>((resolve, reject) =>
      http.server.close((error) => (error ? reject(error) : resolve())),
    ),
  ]);
  return [sql.port, http.port];
}

async function runCockroachDemo(sql: string) {
  const [sqlPort, httpPort] = await availablePorts();
  return spawnSync(
    "cockroach",
    [
      "demo",
      "--empty",
      "--insecure",
      `--sql-port=${sqlPort}`,
      `--http-port=${httpPort}`,
      "--format=csv",
      "--execute",
      sql,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
}

describe.runIf(cockroachAvailable)(
  "083 durable Watch slots upgrade on CockroachDB",
  () => {
    it("is rerunnable, preserves tied history, and fails closed on unsafe legacy ownership/filter data", async () => {
      const migration = readFileSync(
        new URL("../migrations/089-watch-scheduled-slots.sql", import.meta.url),
        "utf8",
      );
      const setup = `
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        timezone STRING
      );
      CREATE TABLE watches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name STRING NOT NULL,
        source_text STRING NOT NULL,
        cadence STRING NOT NULL,
        hour_of_day INT,
        day_of_week INT,
        filter JSONB NOT NULL DEFAULT '{}'::JSONB,
        action STRING NOT NULL,
        status STRING NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_run_at TIMESTAMPTZ,
        next_run_at TIMESTAMPTZ
      );
      CREATE TABLE watch_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        watch_id UUID NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        action STRING NOT NULL,
        matched_count INT NOT NULL DEFAULT 0,
        summary STRING NOT NULL DEFAULT '',
        matched_refs JSONB NOT NULL DEFAULT '[]'::JSONB
      );
      INSERT INTO users VALUES
        ('00000000-0000-4000-8000-000000000001', 'UTC'),
        ('00000000-0000-4000-8000-000000000002', 'UTC');
      INSERT INTO watches (
        id, user_id, name, source_text, cadence, filter, action, status, next_run_at
      ) VALUES
        ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
         'unsafe', 'unsafe legacy filter', 'daily',
         '{"keywords":[null,"   "],"sources":"gmail"}', 'digest', 'active', now()),
        ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
         'safe', 'valid filter', 'daily',
         '{"sources":["gmail"]}', 'digest', 'active', now()),
        ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
         'unknown-only', 'unknown legacy key', 'daily',
         '{"unrecognized":["looks narrow"]}', 'digest', 'active', now());
      INSERT INTO watch_runs (
        id, watch_id, user_id, ran_at, action, matched_count, summary, matched_refs
      ) VALUES
        ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
         '00000000-0000-4000-8000-000000000001', '2026-09-01T08:00:00Z', 'digest', 1, 'one', '["s1"]'),
        ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
         '00000000-0000-4000-8000-000000000001', '2026-09-01T08:00:00Z', 'digest', 1, 'two', '["s2"]'),
        ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002',
         '00000000-0000-4000-8000-000000000001', '2026-09-01T08:00:00.000001Z', 'digest', 1, 'adjacent', '["s3"]'),
        ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002',
         '00000000-0000-4000-8000-000000000002', '2026-09-01T09:00:00Z', 'digest', 1, 'ambiguous', '["other-user"]');
    `;
      const verify = `
      SELECT
        (SELECT status FROM watches WHERE name = 'unsafe') = 'draft' AS malformed_made_inert,
        (SELECT next_run_at FROM watches WHERE name = 'unsafe') IS NULL AS unsafe_unscheduled,
        (SELECT status FROM watches WHERE name = 'safe') = 'active' AS valid_stays_active,
        (SELECT status FROM watches WHERE name = 'unknown-only') = 'draft' AS unknown_key_made_inert,
        (SELECT filter->'keywords' FROM watches WHERE name = 'unsafe') = '[]'::JSONB AS blanks_removed,
        (SELECT filter->'sources' FROM watches WHERE name = 'unsafe') = '[]'::JSONB AS scalar_removed,
        (SELECT count(*) FROM watch_runs) = 3 AS mismatched_owner_deleted,
        (SELECT count(DISTINCT scheduled_for) FROM watch_runs) = 3 AS tied_runs_disambiguated,
        (SELECT count(*) FROM watch_runs WHERE slot_status = 'completed') = 3 AS history_completed,
        EXISTS (
          SELECT 1 FROM [SHOW CONSTRAINTS FROM watch_runs]
           WHERE constraint_name = 'watch_runs_watch_owner_fk'
        ) AS composite_owner_installed,
        EXISTS (
          SELECT 1 FROM [SHOW CONSTRAINTS FROM watches]
           WHERE constraint_name = 'watches_active_filter_chk'
        ) AS filter_guard_installed;
    `;
      const result = await runCockroachDemo(
        `${setup}\n${migration}\n${migration}\n${verify}`,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("t,t,t,t,t,t,t,t,t,t,t");
    }, 30_000);
  },
);
