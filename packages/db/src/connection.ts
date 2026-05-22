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
  connectionTimeoutMillis?: number;
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
 * Unknown values fall through to undefined so a typo doesn't silently
 * downgrade — the env-var fallback path applies as before.
 */
function sslConfigForSslmode(sslmode: string | null): DatabaseConfig['ssl'] | undefined {
  if (sslmode === null) return undefined;
  if (sslmode === 'disable') return false;
  if (sslmode === 'require') return { rejectUnauthorized: false };
  if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
    return { rejectUnauthorized: true };
  }
  return undefined;
}

function parseDatabaseUrl(url: string): Partial<DatabaseConfig> | null {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 26257,
      database: u.pathname.replace(/^\//, '') || 'skytwin',
      user: decodeURIComponent(u.username) || 'root',
      password: u.password ? decodeURIComponent(u.password) : undefined,
      ssl: sslConfigForSslmode(u.searchParams.get('sslmode')),
    };
  } catch {
    return null;
  }
}

const FROM_URL = process.env['DATABASE_URL']
  ? parseDatabaseUrl(process.env['DATABASE_URL'])
  : null;

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
