/**
 * Destructive upgrade coverage for migration 081. Run only against a
 * disposable CockroachDB database:
 *
 * E2E=true WORKER_DLQ_MIGRATION_E2E=true DATABASE_URL=... \
 *   pnpm --filter @skytwin/db exec vitest run \
 *   src/__tests__/worker-dead-letter-migration.e2e.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { splitSqlStatements } from "../migrations/001-initial.js";

const ENABLED =
  process.env["E2E"] === "true" &&
  process.env["WORKER_DLQ_MIGRATION_E2E"] === "true";

const LEGACY_MIGRATION = readFileSync(
  new URL("../migrations/065-worker-dead-letter.sql", import.meta.url),
  "utf8",
);
const CONTENT_FREE_MIGRATION = readFileSync(
  new URL(
    "../migrations/081-worker-dead-letter-content-free.sql",
    import.meta.url,
  ),
  "utf8",
);
const SECRET =
  "password=hunter2 user=private@example.test prompt=private payload={secret}";

let pool: Pool;

async function applyMigration(client: PoolClient, sql: string): Promise<void> {
  for (const statement of splitSqlStatements(sql)) {
    await client.query(statement);
  }
}

describe.skipIf(!ENABLED)(
  "E2E: worker dead-letter content-free migration",
  () => {
    beforeAll(() => {
      const databaseUrl = process.env["DATABASE_URL"];
      if (!databaseUrl) {
        throw new Error(
          "DATABASE_URL must be set for worker DLQ migration E2E",
        );
      }
      pool = new Pool({ connectionString: databaseUrl, max: 1 });
    });

    afterAll(async () => {
      await pool.end();
    }, 30_000);

    it("erases legacy diagnostics and remains idempotent on CockroachDB", async () => {
      const client = await pool.connect();
      const schema = `dlq_migration_${randomUUID().replaceAll("-", "")}`;

      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}"`);
        await applyMigration(client, LEGACY_MIGRATION);
        await client.query(
          `INSERT INTO worker_dead_letter
           (job_name, error_message, attempts, context)
         VALUES ($1, $2, 3, $3::JSONB)`,
          ["embedding-backfill", SECRET, JSON.stringify({ secret: SECRET })],
        );

        await applyMigration(client, CONTENT_FREE_MIGRATION);

        const columns = await client.query<{
          column_name: string;
          column_default: string | null;
        }>(
          `SELECT column_name, column_default
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'worker_dead_letter'
          ORDER BY column_name`,
          [schema],
        );
        expect(columns.rows.map(({ column_name: name }) => name)).toEqual([
          "attempts",
          "correlation_id",
          "dead_lettered_at",
          "error_code",
          "id",
          "job_code",
          "resolved_at",
          "status",
        ]);
        for (const name of ["correlation_id", "error_code", "job_code"]) {
          expect(
            columns.rows.find(
              ({ column_name: columnName }) => columnName === name,
            )?.column_default,
          ).toBeNull();
        }

        const migrated = await client.query<{
          id: string;
          correlation_id: string;
          job_code: string;
          error_code: string;
          attempts: string;
          status: string;
        }>("SELECT * FROM worker_dead_letter");
        expect(migrated.rows).toHaveLength(1);
        expect(migrated.rows[0]).toMatchObject({
          job_code: "legacy-redacted",
          error_code: "legacy-redacted",
          attempts: "3",
          status: "pending",
        });
        expect(migrated.rows[0]!.correlation_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(JSON.stringify(migrated.rows)).not.toContain(SECRET);
        await expect(
          client.query(
            "SELECT job_name, error_message, context FROM worker_dead_letter",
          ),
        ).rejects.toThrow(/column .* does not exist/i);

        const constraints = await client.query<{
          constraint_name: string;
          validated: boolean;
        }>("SHOW CONSTRAINTS FROM worker_dead_letter");
        for (const name of [
          "worker_dead_letter_job_code_check",
          "worker_dead_letter_error_code_check",
        ]) {
          expect(constraints.rows).toContainEqual(
            expect.objectContaining({ constraint_name: name, validated: true }),
          );
        }

        const indexes = await client.query<{
          index_name: string;
          seq_in_index: string;
          column_name: string;
          direction: string;
        }>(
          "SHOW INDEXES FROM worker_dead_letter",
        );
        const indexNames = new Set(
          indexes.rows.map(({ index_name: name }) => name),
        );
        expect(indexNames.has("worker_dead_letter_job_code_idx")).toBe(true);
        expect(indexNames.has("worker_dead_letter_pending_idx")).toBe(true);
        expect(indexNames.has("worker_dead_letter_job_idx")).toBe(false);
        expect(
          indexes.rows
            .filter(
              ({ index_name: name }) =>
                name === "worker_dead_letter_job_code_idx",
            )
            .slice(0, 2)
            .map(({ column_name: column, direction }) => ({
              column,
              direction,
            })),
        ).toEqual([
          { column: "job_code", direction: "ASC" },
          { column: "dead_lettered_at", direction: "DESC" },
        ]);

        const beforeRerun = migrated.rows[0];
        await applyMigration(client, CONTENT_FREE_MIGRATION);
        const afterRerun = await client.query(
          "SELECT * FROM worker_dead_letter",
        );
        expect(afterRerun.rows).toEqual([beforeRerun]);

        await expect(
          client.query(`INSERT INTO worker_dead_letter (attempts) VALUES (1)`),
        ).rejects.toThrow(/null value.*job_code|not-null constraint/i);
        await expect(
          client.query(
            `INSERT INTO worker_dead_letter
             (job_code, error_code, attempts, correlation_id)
           VALUES ('source-bearing-job', 'job-failed', 1, gen_random_uuid())`,
          ),
        ).rejects.toThrow(
          /worker_dead_letter_job_code_check|check constraint/i,
        );
        await expect(
          client.query(
            `INSERT INTO worker_dead_letter
             (job_code, error_code, attempts, correlation_id)
           VALUES ('embedding-backfill', 'source-bearing-error', 1, gen_random_uuid())`,
          ),
        ).rejects.toThrow(
          /worker_dead_letter_error_code_check|check constraint/i,
        );
      } finally {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
      }
    }, 120_000);
  },
);
