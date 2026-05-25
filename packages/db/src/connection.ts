import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Database configuration for CockroachDB connection.
 */
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  max?: number;
  idleTimeoutMillis?: number;
  /**
   * Maximum time to wait when establishing a new TCP connection to the
   * DB server. In node-postgres pg-pool, this ALSO governs the wait for
   * a free connection from a saturated pool — without it, the 21st
   * concurrent acquire on a `max: 20` pool hangs forever (#378).
   */
  connectionTimeoutMillis?: number;
  /**
   * Explicit acquire-from-pool timeout (#378). Supported in pg-pool ≥
   * v3.6. On versions that don't recognize this key, the value is
   * silently ignored and `connectionTimeoutMillis` is the effective
   * bound — both are set so the behavior is identical either way.
   */
  acquireTimeoutMillis?: number;
}

/**
 * Default configuration for local CockroachDB development.
 *
 * The separate DATABASE_HOST/PORT/NAME env vars predate the desktop
 * bundle which builds its connection string dynamically (CockroachManager
 * picks a non-default port via SKYTWIN_DB_PORT). When DATABASE_URL is
 * set, parse it and use it as the source of truth — otherwise fall back
 * to the per-piece vars. Without this, the bundled desktop app would
 * silently apply migrations to whatever happened to be on the default
 * 26257 (the user's stray `docker compose` CRDB, for instance) while the
 * bundled CRDB on the chosen port stayed empty — every downstream query
 * 500s and OAuth callbacks die on "column does not exist".
 */
/**
 * Translate libpq `sslmode=` values to node-postgres ssl config. Without
 * an explicit handler for `require`/`verify-ca`/`verify-full`, the previous
 * implementation returned `undefined` for everything except `disable` —
 * which means a `DATABASE_URL=…?sslmode=require` would fall through to
 * the `DATABASE_SSL` env var (default false) and connect over plaintext,
 * silently downgrading the connection against a secure CRDB cluster.
 *
 *   disable       → false                            (no SSL)
 *   allow / prefer → undefined (let node-postgres decide; mirrors libpq)
 *   require       → { rejectUnauthorized: false }    (SSL, skip CA check —
 *                                                     same shape as the
 *                                                     legacy DATABASE_SSL=true)
 *   verify-ca, verify-full → { rejectUnauthorized: true }
 *
 * Unknown values throw a typed error rather than falling through to the
 * `DATABASE_SSL` fallback. The previous behaviour returned `undefined` on
 * a typo (e.g. `sslmode=requier`) which then hit the env-var path; with
 * `DATABASE_SSL` unset (the default), the connection silently downgraded
 * to plaintext against a secure CRDB cluster. A startup-time throw forces
 * the operator to fix the misspelling rather than ship a covert plaintext
 * link. Module-load callers see the error via getPool() the first time
 * they request a connection.
 */
function sslConfigForSslmode(sslmode: string | null): DatabaseConfig['ssl'] | undefined {
  if (sslmode === null) return undefined;
  if (sslmode === 'disable') return false;
  if (sslmode === 'allow' || sslmode === 'prefer') return undefined;
  if (sslmode === 'require') return { rejectUnauthorized: false };
  if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
    return { rejectUnauthorized: true };
  }
  throw new Error(
    `DATABASE_URL sslmode=${JSON.stringify(sslmode)} is not a recognized libpq value. ` +
    `Use one of: disable, allow, prefer, require, verify-ca, verify-full. ` +
    `An unrecognized value would otherwise fall through to the DATABASE_SSL env var (default false) ` +
    `and silently downgrade the connection to plaintext.`,
  );
}

function parseDatabaseUrl(url: string): Partial<DatabaseConfig> | null {
  // Two failure modes to keep separate:
  //   - URL itself is malformed (`new URL` throws): the whole DATABASE_URL is
  //     unusable. Return null so the caller falls back to DATABASE_HOST/PORT
  //     env vars — that's the legacy contract.
  //   - URL parses but `sslmode` is misspelled (e.g. `sslmode=requier`):
  //     sslConfigForSslmode throws a typed error. We DELIBERATELY do NOT
  //     catch this — it must propagate so the operator sees the misspelling
  //     at startup instead of silently downgrading to plaintext via the
  //     `DATABASE_SSL=false` env-var fallback. An earlier version of this
  //     function wrapped both calls in one try/catch and swallowed the
  //     sslmode throw, which defeated the whole point.
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 26257,
    database: u.pathname.replace(/^\//, '') || 'skytwin',
    user: decodeURIComponent(u.username) || 'root',
    password: u.password ? decodeURIComponent(u.password) : undefined,
    ssl: sslConfigForSslmode(u.searchParams.get('sslmode')),
  };
}

// Wrapped so an invalid sslmode at module load doesn't cascade-crash every
// consumer of @skytwin/db at import time (test files, migration scripts,
// type-checker tooling). DEFAULT_CONFIG below falls back to DATABASE_HOST/
// PORT/NAME env vars when FROM_URL is null. The throw is deferred to
// getPool() — which re-parses fresh — so an actively-connecting caller
// surfaces the bad sslmode loudly, while passive importers don't.
const FROM_URL = (() => {
  if (!process.env['DATABASE_URL']) return null;
  try {
    return parseDatabaseUrl(process.env['DATABASE_URL']);
  } catch {
    return null;
  }
})();

const DEFAULT_CONFIG: DatabaseConfig = {
  host: FROM_URL?.host ?? process.env['DATABASE_HOST'] ?? 'localhost',
  port: FROM_URL?.port ?? parseInt(process.env['DATABASE_PORT'] ?? '26257', 10),
  database: FROM_URL?.database ?? process.env['DATABASE_NAME'] ?? 'skytwin',
  user: FROM_URL?.user ?? process.env['DATABASE_USER'] ?? 'root',
  password: FROM_URL?.password ?? process.env['DATABASE_PASSWORD'] ?? undefined,
  ssl: FROM_URL?.ssl ?? (process.env['DATABASE_SSL'] === 'true'
    ? { rejectUnauthorized: false }
    : false),
  max: parseInt(process.env['DATABASE_POOL_MAX'] ?? '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // The 21st concurrent acquire on a saturated max=20 pool now fails
  // within ~5s with a clear timeout error instead of hanging forever.
  // Pre-fix, the pool had no acquire bound and a long-running query
  // (or a 20-connection deadlock) silently froze every subsequent
  // request — health endpoints reported 200, the SSE pill said
  // "Listening", and every actual user operation hung. See #378.
  acquireTimeoutMillis: 5000,
};

let pool: Pool | null = null;

/**
 * Get or create the database connection pool.
 * Uses singleton pattern to ensure a single pool instance.
 */
export function getPool(config?: Partial<DatabaseConfig>): Pool {
  if (!pool) {
    // Recompute DATABASE_URL parse at each first call so a service-manager
    // that injects env vars after the module was imported (in-process
    // migrations on Electron main) still picks up the right host/port.
    // Unlike the module-load parse, this one is NOT wrapped — an invalid
    // sslmode here SHOULD crash the caller because they're actively asking
    // for a connection. This is the deferred-throw the module-load wrap
    // promises.
    const fromUrl = process.env['DATABASE_URL']
      ? parseDatabaseUrl(process.env['DATABASE_URL'])
      : null;
    const merged: DatabaseConfig = {
      ...DEFAULT_CONFIG,
      ...(fromUrl ?? {}),
      ...config,
    };
    pool = new Pool({
      host: merged.host,
      port: merged.port,
      database: merged.database,
      user: merged.user,
      password: merged.password,
      ssl: merged.ssl,
      max: merged.max,
      idleTimeoutMillis: merged.idleTimeoutMillis,
      connectionTimeoutMillis: merged.connectionTimeoutMillis,
    });

    pool.on('error', (err) => {
      console.error('[db] Unexpected pool error:', err.message);
    });
  }

  return pool;
}

/**
 * Execute a single query against the pool.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const p = getPool();
  const start = Date.now();
  const result = await p.query<T>(text, params);
  const duration = Date.now() - start;

  if (duration > 1000) {
    console.warn(`[db] Slow query (${duration}ms):`, text.substring(0, 100));
  }

  return result;
}

/**
 * Execute a function within a database transaction.
 * Automatically rolls back on error.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = getPool();
  const client = await p.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Check the health of the database connection.
 * Returns true if the database is reachable and responsive.
 */
export async function healthCheck(): Promise<{
  healthy: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();

  try {
    await query('SELECT 1 AS health');
    return {
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Gracefully close the database pool.
 * Should be called during application shutdown.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Get the current pool statistics.
 */
export function getPoolStats(): {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
} | null {
  if (!pool) return null;
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}
