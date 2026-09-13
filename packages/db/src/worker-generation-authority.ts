import { createHash } from "node:crypto";
import { Client, type QueryResult } from "pg";

const CONNECTION_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 10_000;

export interface WorkerGenerationAuthorityOptions {
  readonly connectionString: string;
  readonly generationId: string;
  readonly generationSecret: string;
  readonly authorize: () => boolean;
  readonly createClient?: (
    connectionString: string,
  ) => WorkerGenerationAuthorityClient;
}

export interface WorkerGenerationAuthorityClient {
  connect(): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}

function createClient(
  connectionString: string,
): WorkerGenerationAuthorityClient {
  return new Client({
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
}

function secretHash(secret: string): string {
  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error(
      "Worker generation secret must be 32 bytes of hexadecimal data",
    );
  }
  return createHash("sha256").update(secret).digest("hex");
}

function requireAuthority(options: WorkerGenerationAuthorityOptions): void {
  if (!options.authorize()) {
    throw new Error("CockroachDB or API generation authority changed");
  }
}

async function inAuthorityTransaction(
  options: WorkerGenerationAuthorityOptions,
  operation: (
    client: WorkerGenerationAuthorityClient,
    hash: string,
  ) => Promise<void>,
): Promise<void> {
  const client = (options.createClient ?? createClient)(
    options.connectionString,
  );
  const hash = secretHash(options.generationSecret);
  await client.connect();
  try {
    requireAuthority(options);
    await client.query("BEGIN");
    requireAuthority(options);
    await operation(client, hash);
    requireAuthority(options);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export async function registerWorkerGenerationAuthority(
  options: WorkerGenerationAuthorityOptions,
): Promise<void> {
  await inAuthorityTransaction(options, async (client, hash) => {
    await client.query(
      `UPDATE worker_generation_authority
          SET active = false, revoked_at = now()
        WHERE active = true AND id <> $1`,
      [options.generationId],
    );
    requireAuthority(options);
    await client.query(
      `INSERT INTO worker_generation_authority (id, secret_hash, active, revoked_at)
       VALUES ($1, $2, true, NULL)
       ON CONFLICT (id) DO UPDATE
         SET secret_hash = excluded.secret_hash,
             active = true,
             revoked_at = NULL`,
      [options.generationId, hash],
    );
  });
}

export async function revokeWorkerGenerationAuthority(
  options: WorkerGenerationAuthorityOptions,
): Promise<void> {
  await inAuthorityTransaction(options, async (client, hash) => {
    const result = await client.query(
      `UPDATE worker_generation_authority
          SET active = false, revoked_at = now()
        WHERE id = $1 AND secret_hash = $2 AND active = true`,
      [options.generationId, hash],
    );
    if (result.rowCount === 1) return;
    const existing = await client.query(
      `SELECT secret_hash, active
         FROM worker_generation_authority
        WHERE id = $1`,
      [options.generationId],
    );
    // A registration that failed before its INSERT is indistinguishable at
    // the caller from a lost COMMIT response. Treat absence as an idempotent
    // cleanup success; a same-ID row with a different secret still fails.
    if (existing.rowCount === 0) return;
    if (
      existing.rowCount !== 1 ||
      existing.rows[0]?.["secret_hash"] !== hash ||
      existing.rows[0]?.["active"] !== false
    ) {
      throw new Error(
        "Worker generation authority could not be revoked exactly",
      );
    }
  });
}
