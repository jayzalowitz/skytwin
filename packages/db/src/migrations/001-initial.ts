import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { getPool, closePool } from '../connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, '..', 'schemas', 'schema.sql');

export interface MigrationSqlSource {
  name: string;
  sql: string;
}

function migrationSqlSources(): MigrationSqlSource[] {
  return [
    { name: 'schema.sql', sql: readFileSync(SCHEMA_PATH, 'utf-8') },
    ...readdirSync(__dirname)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => ({ name: file, sql: readFileSync(join(__dirname, file), 'utf-8') })),
  ];
}

function unquoteSqlIdentifier(identifier: string): string {
  return identifier.startsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier;
}

/**
 * Derive the SkyTwin-owned table boundary from checked-in DDL, never from the
 * database namespace. `all` includes tables later removed by a migration so a
 * rollback can also clean an interrupted/older install; `current` applies the
 * checked-in DROP TABLE statements and is the expected post-up manifest.
 */
export function deriveOwnedTableManifest(sources: readonly MigrationSqlSource[]): {
  all: string[];
  current: string[];
} {
  const all = new Set<string>();
  const current = new Set<string>();
  const identifier = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
  const createPattern = new RegExp(
    `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:(?:public|"public")\\.)?(${identifier})(?![A-Za-z0-9_$"]|\\s*\\.)`,
    'gi',
  );
  const dropPattern = new RegExp(
    `\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:(?:public|"public")\\.)?(${identifier})(?![A-Za-z0-9_$"]|\\s*\\.)`,
    'gi',
  );

  for (const source of sources) {
    // Ownership is a property of executable DDL, not prose in a migration
    // comment. The migration runner has the same line-comment limitation.
    const ddl = source.sql.replace(/--[^\n]*/g, '');
    const createStatements = ddl.match(/\bCREATE\s+TABLE\b/gi) ?? [];
    const created = [...ddl.matchAll(createPattern)];
    if (created.length !== createStatements.length) {
      throw new Error(`[migration] Cannot derive every owned table from ${source.name}`);
    }
    for (const match of created) {
      const name = unquoteSqlIdentifier(match[1]!);
      all.add(name);
      current.add(name);
    }
    for (const match of ddl.matchAll(dropPattern)) {
      current.delete(unquoteSqlIdentifier(match[1]!));
    }
  }

  return {
    all: [...all].sort(),
    current: [...current].sort(),
  };
}

export function getSkyTwinOwnedTableManifest(): { all: string[]; current: string[] } {
  return deriveOwnedTableManifest(migrationSqlSources());
}

/**
 * SQLSTATE codes that mean "this DDL object already exists" — re-running
 * a migration that hits one of these is a no-op, not a failure. Checking
 * the code is more robust than substring-matching the error message,
 * which is vendor-specific and can change between CockroachDB versions.
 *   42710 duplicate_object   (covers duplicate constraint / index names)
 *   42P07 duplicate_table
 *   42701 duplicate_column
 *
 * 23505 (unique_violation) is deliberately NOT in this set, and the
 * runner does not absorb it under any circumstances. Earlier versions
 * swallowed 23505 to make re-running a seed `INSERT` a no-op, but that
 * carve-out also masked real failures: a `CREATE UNIQUE INDEX` blocked
 * by residual duplicates, an `INSERT ... SELECT` backfill hitting a real
 * collision, an `ALTER TABLE ... ADD CONSTRAINT UNIQUE` failing on
 * dirty data — all of those returned 23505 too and were silently
 * absorbed. Migration 046 surfaced the bug by writing a self-verify
 * check; Codex's review of the original "narrow to INSERT" fix called
 * out that statement-shape carve-outs are also leaky. The runner now
 * has one rule: 23505 always surfaces. Seed migrations that need
 * re-run safety use `INSERT ... ON CONFLICT DO NOTHING` — the idiomatic
 * Postgres pattern — to mark the intent explicitly. No current migration
 * relies on the old swallow: `grep -E '^\s*INSERT' packages/db/src/migrations/*.sql`
 * returns zero hits (one bare `INSERT` appears in 039-model-downloads.sql,
 * but only inside a `--` comment line, not as a statement).
 */
const IDEMPOTENT_DDL_CODES = new Set(['42710', '42P07', '42701']);
const OWNED_MIGRATION_CONNECTION_TIMEOUT_MS = 5_000;
const OWNED_MIGRATION_QUERY_TIMEOUT_MS = 120_000;

interface MigrationQueryable {
  query(text: string): Promise<unknown>;
}

export interface OwnedMigrationClient extends MigrationQueryable {
  connect(): Promise<unknown>;
  end(): Promise<void>;
}

export interface OwnedMigrationOptions {
  /** Exact endpoint selected by the desktop-owned CockroachDB capability. */
  connectionString: string;
  /**
   * Revalidates the desktop's child-process capability. This callback is
   * checked after each non-reconnecting connection is established and
   * immediately before every write.
   */
  authorize: () => boolean;
  /** Test seam for proving connection and authority sequencing. */
  createClient?: (connectionString: string) => OwnedMigrationClient;
}

function requireOwnedMigrationAuthority(authorize: () => boolean): void {
  if (!authorize()) {
    throw new Error('CockroachDB ownership changed; refusing migration write');
  }
}

function migrationClient(connectionString: string): OwnedMigrationClient {
  return new Client({
    connectionString,
    connectionTimeoutMillis: OWNED_MIGRATION_CONNECTION_TIMEOUT_MS,
    query_timeout: OWNED_MIGRATION_QUERY_TIMEOUT_MS,
  });
}

/**
 * Split a .sql migration file into individual statements.
 *
 * `--` line comments are stripped *before* splitting so a stray `;` at
 * the end of a comment line can't break a statement in half. Statements
 * are split on `;` followed by end-of-line, then trimmed; empty blocks
 * are dropped.
 *
 * Caveats — this is a line-comment-aware splitter, not a SQL parser.
 * Unsupported constructs (none appear in the current corpus, all
 * verified):
 *   - "--" inside a string literal (would be mis-stripped;
 *     assertBalancedQuotes catches this one at run time)
 *   - C-style slash-star block comments (not stripped — a ";" inside
 *     one would still split a statement)
 *   - dollar-quoted strings, "$$ ... $$" / "$tag$ ... $tag$" (a ";" or
 *     "--" inside one is not protected)
 * A migration needing any of these must be split differently, or the
 * splitter extended into a real tokenizer.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    assertBalancedQuotes(stmt);
  }
  return statements;
}

/**
 * Throw if a statement has an odd number of single-quote characters.
 * In SQL, every string literal opens and closes with `'` and an escaped
 * quote inside a literal is `''` (two chars) — so a well-formed
 * statement always has an even count. An odd count means either the
 * statement is malformed or the comment-strip in `splitSqlStatements`
 * ate a `--` that was inside a string literal. Either way: fail loud.
 */
function assertBalancedQuotes(statement: string): void {
  const singleQuotes = (statement.match(/'/g) ?? []).length;
  if (singleQuotes % 2 !== 0) {
    throw new Error(
      `[migration] statement has unbalanced single-quotes after comment-strip — ` +
        `a "--" inside a string literal may have been mis-stripped:\n${statement.substring(0, 200)}`,
    );
  }
}

/**
 * True when an error from `pool.query` means the statement is safe to
 * skip — i.e. it was already applied on a prior run. Prefers the stable
 * SQLSTATE code; falls back to message substrings for drivers/errors
 * that don't surface a code.
 *
 * Only DDL "already exists" conditions are treated as idempotent.
 * Unique-violation (23505 / "duplicate key") is deliberately NOT in
 * this set — see the doc block on `IDEMPOTENT_DDL_CODES` for why.
 * Seed migrations that need re-run safety use `INSERT ... ON CONFLICT
 * DO NOTHING` to mark the intent at the statement level instead of
 * relying on the runner to guess.
 *
 * The 23505 anti-swallow runs before the message-substring fallback so
 * a 23505 whose message happens to contain "already exists" (some
 * driver variants append that phrase) is rejected explicitly instead
 * of being absorbed via the DDL message path. The check uses
 * `String(code) === '23505'` so a numeric `code: 23505` is caught too
 * — node-postgres always stringifies, but other pg clients (or a hand-
 * built driver) may not, and the safer default is to anchor on value
 * rather than on the JS type that surfaced it.
 *
 * As a belt-and-suspenders, `message.includes('duplicate key')` is
 * also vetoed before the DDL fallback — covers the case where a
 * driver elides `code` entirely on a 23505 and only carries the
 * canonical "duplicate key value" message.
 */
export function isIdempotentError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && IDEMPOTENT_DDL_CODES.has(code)) {
    return true;
  }
  if (code != null && String(code) === '23505') {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('duplicate key')) {
    return false;
  }
  return (
    message.includes('already exists') ||
    message.includes('duplicate column name') ||
    message.includes('duplicate constraint name')
  );
}

async function applyMigrations(
  client: MigrationQueryable,
  authorize: () => boolean,
): Promise<void> {
  // Read and execute the entire schema as one batch.
  // Running it as a single query preserves statement ordering so FK
  // references resolve correctly (e.g. connected_accounts → users).
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');

  try {
    requireOwnedMigrationAuthority(authorize);
    await client.query(schema);
  } catch (error) {
    // Use the same idempotency rule as the per-statement loop below —
    // DDL "already exists" is swallowed; 23505 (unique-violation) and
    // any other shape always surfaces. Previously this branch used a
    // raw `message.includes('already exists')` check, which would have
    // swallowed a 23505 whose message happens to contain that phrase
    // (some driver variants do append it) — inconsistent with the
    // per-statement loop's stricter behaviour.
    if (!isIdempotentError(error)) {
      console.error(`[migration] Failed to execute schema`);
      throw error;
    }
  }

  console.log('[migration] 001-initial: All tables created successfully.');

  // Run incremental SQL migrations (002-xxx.sql, 003-xxx.sql, …)
  // These must be executed statement-by-statement because CockroachDB
  // cannot run ALTER+UPDATE+ALTER in a single batch (backfill conflict).
  const sqlFiles = readdirSync(__dirname)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of sqlFiles) {
    const sql = readFileSync(join(__dirname, file), 'utf-8');
    const statements = splitSqlStatements(sql);

    let applied = 0;
    for (const stmt of statements) {
      try {
        requireOwnedMigrationAuthority(authorize);
        await client.query(stmt);
        applied++;
      } catch (error) {
        if (isIdempotentError(error)) {
          // Already applied on a prior run — skip
          continue;
        }
        console.error(`[migration] ${file}: statement failed:\n${stmt.substring(0, 120)}`);
        throw error;
      }
    }
    console.log(`[migration] ${file}: applied ${applied} statement(s).`);
  }
}

/**
 * Run all migrations for CLI/development callers using the shared pool.
 */
export async function up(): Promise<void> {
  const pool = getPool();

  // Development deployments normally provision the database externally.
  // Keep the historical best-effort create for compatibility.
  try {
    await pool.query('CREATE DATABASE IF NOT EXISTS skytwin');
  } catch {
    // Database may already exist or we may not have permissions; continue.
  }

  await applyMigrations(pool, () => true);
}

/**
 * Run desktop migrations over fixed, non-reconnecting pg clients.
 *
 * A Pool may reconnect a later statement to a different process after the
 * managed CockroachDB child exits and another listener takes the port. The
 * packaged desktop therefore uses one direct client for database creation
 * and one direct client for the complete migration corpus. Authority is
 * rechecked after connect and before every write; if the owned child dies,
 * the established socket fails instead of redirecting a later statement.
 */
export async function upOwned(options: OwnedMigrationOptions): Promise<void> {
  const targetUrl = new URL(options.connectionString);
  if (targetUrl.protocol !== 'postgresql:' && targetUrl.protocol !== 'postgres:') {
    throw new Error('Owned migration connection must use PostgreSQL');
  }
  if (targetUrl.pathname !== '/skytwin') {
    throw new Error('Owned migration connection must target the skytwin database');
  }

  const adminUrl = new URL(targetUrl);
  adminUrl.pathname = '/defaultdb';
  const createClient = options.createClient ?? migrationClient;
  const admin = createClient(adminUrl.toString());
  try {
    await admin.connect();
    requireOwnedMigrationAuthority(options.authorize);
    await admin.query('CREATE DATABASE IF NOT EXISTS skytwin');
  } finally {
    await admin.end().catch(() => undefined);
  }

  const target = createClient(targetUrl.toString());
  try {
    await target.connect();
    requireOwnedMigrationAuthority(options.authorize);
    await applyMigrations(target, options.authorize);
  } finally {
    await target.end().catch(() => undefined);
  }
}

interface PublicTableRow {
  table_name: string;
}

interface ForeignDependencyRow {
  dependency_kind: string;
  dependency_name: string;
  owned_table_name: string;
}

const OWNED_PUBLIC_BASE_TABLES_SQL = `
  SELECT table_name
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_type = 'BASE TABLE'
     AND table_name = ANY($1::STRING[])
   ORDER BY table_name
`;

const FOREIGN_OWNED_DEPENDENCIES_SQL = `
  SELECT 'foreign_key' AS dependency_kind,
         tc.table_schema || '.' || tc.table_name || '.' || tc.constraint_name AS dependency_name,
         ccu.table_name AS owned_table_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_catalog = tc.constraint_catalog
     AND rc.constraint_schema = tc.constraint_schema
     AND rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_catalog = rc.unique_constraint_catalog
     AND ccu.constraint_schema = rc.unique_constraint_schema
     AND ccu.constraint_name = rc.unique_constraint_name
   WHERE tc.constraint_type = 'FOREIGN KEY'
     AND ccu.table_schema = 'public' AND ccu.table_name = ANY($1::STRING[])
     AND NOT (tc.table_schema = 'public' AND tc.table_name = ANY($1::STRING[]))
  UNION ALL
  SELECT 'view' AS dependency_kind,
         vtu.view_schema || '.' || vtu.view_name AS dependency_name,
         vtu.table_name AS owned_table_name
    FROM information_schema.view_table_usage vtu
   WHERE vtu.table_schema = 'public' AND vtu.table_name = ANY($1::STRING[])
     AND NOT (vtu.view_schema = 'public' AND vtu.view_name = ANY($1::STRING[]))
  ORDER BY dependency_kind, dependency_name, owned_table_name
`;

/** Quote a database-sourced identifier without treating it as SQL text. */
export function quoteSqlIdentifier(identifier: string): string {
  if (identifier.length === 0 || identifier.includes('\0')) {
    throw new Error('[migration] Refusing to quote an empty or NUL-containing SQL identifier');
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function down(): Promise<void> {
  const pool = getPool();
  // A retired name is no longer proof of current ownership. If an operator
  // reuses it after an upgrade, rollback must preserve their replacement.
  const owned = getSkyTwinOwnedTableManifest().current;

  const dependencies = await pool.query<ForeignDependencyRow>(
    FOREIGN_OWNED_DEPENDENCIES_SQL,
    [owned],
  );
  if (dependencies.rows.length > 0) {
    const details = dependencies.rows.map((row) =>
      `${row.dependency_kind} ${row.dependency_name} -> public.${row.owned_table_name}`
    ).join(', ');
    throw new Error(
      `[migration] Refusing rollback: operator-owned objects depend on SkyTwin tables: ${details}`,
    );
  }

  // The manifest follows checked-in CREATE/DROP TABLE DDL, including tables
  // removed by later migrations. Never infer ownership from everything in the
  // shared `public` namespace: operators may colocate unrelated tables there.
  const existing = await pool.query<PublicTableRow>(OWNED_PUBLIC_BASE_TABLES_SQL, [owned]);
  if (existing.rows.length > 0) {
    const qualifiedTables = existing.rows
      .map(({ table_name: tableName }) =>
        `${quoteSqlIdentifier('public')}.${quoteSqlIdentifier(tableName)}`)
      .join(', ');
    // One schema change avoids scheduling a separate CockroachDB job for
    // every table while retaining all-or-error behavior for the enumerated
    // set.
    // Listing the complete owned graph lets Cockroach remove its internal FKs
    // without CASCADE. Any unrecognised external dependency makes the whole
    // statement fail rather than silently mutating an operator-owned object.
    await pool.query(`DROP TABLE ${qualifiedTables}`);
  }

  const survivors = await pool.query<PublicTableRow>(OWNED_PUBLIC_BASE_TABLES_SQL, [owned]);
  if (survivors.rows.length > 0) {
    throw new Error(
      `[migration] 001-initial: rollback left SkyTwin-owned tables behind: ${
        survivors.rows.map(({ table_name: tableName }) => tableName).join(', ')
      }`,
    );
  }

  console.log('[migration] 001-initial: All SkyTwin-owned tables dropped.');
}

/**
 * CLI entry point.
 * Usage:
 *   tsx src/migrations/001-initial.ts        # runs up()
 *   tsx src/migrations/001-initial.ts down    # runs down()
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';

  try {
    if (command === 'down') {
      await down();
    } else {
      await up();
    }
  } catch (error) {
    console.error('[migration] Migration failed:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Only run the migration when this file is executed directly as a CLI
// (`tsx src/migrations/001-initial.ts`), NOT when it is imported — e.g.
// migration-runner.test.ts imports the pure `splitSqlStatements` /
// `isIdempotentError` helpers and must not trigger a DB connection +
// `process.exit` on load.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
