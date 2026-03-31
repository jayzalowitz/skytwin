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
 */
const DEFAULT_CONFIG: DatabaseConfig = {
  host: process.env['DATABASE_HOST'] ?? 'localhost',
  port: parseInt(process.env['DATABASE_PORT'] ?? '26257', 10),
  database: process.env['DATABASE_NAME'] ?? 'skytwin',
  user: process.env['DATABASE_USER'] ?? 'root',
  password: process.env['DATABASE_PASSWORD'] ?? undefined,
  ssl: process.env['DATABASE_SSL'] === 'true'
    ? { rejectUnauthorized: false }
    : false,
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
    const finalConfig = { ...DEFAULT_CONFIG, ...config };
    pool = new Pool({
      host: finalConfig.host,
      port: finalConfig.port,
      database: finalConfig.database,
      user: finalConfig.user,
      password: finalConfig.password,
      ssl: finalConfig.ssl,
      max: finalConfig.max,
      idleTimeoutMillis: finalConfig.idleTimeoutMillis,
      connectionTimeoutMillis: finalConfig.connectionTimeoutMillis,
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
