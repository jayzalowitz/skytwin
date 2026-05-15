import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPool, closePool } from '../connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, '..', 'schemas', 'schema.sql');

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
 * relies on the old swallow (`grep INSERT packages/db/src/migrations/*.sql`
 * returns zero hits).
 */
const IDEMPOTENT_DDL_CODES = new Set(['42710', '42P07', '42701']);

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
 * A 23505 whose message happens to contain "already exists" (some
 * driver variants append that phrase) is rejected via an explicit
 * code-anchored guard before the message-substring fallback runs —
 * otherwise the fallback would swallow it.
 */
export function isIdempotentError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && IDEMPOTENT_DDL_CODES.has(code)) {
    return true;
  }
  if (code === '23505') {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('already exists') ||
    message.includes('duplicate column name') ||
    message.includes('duplicate constraint name')
  );
}

/**
 * Run all migrations: schema.sql first, then SQL files 002–011 in order.
 */
export async function up(): Promise<void> {
  const pool = getPool();

  // Ensure the database exists
  try {
    await pool.query('CREATE DATABASE IF NOT EXISTS skytwin');
  } catch {
    // Database may already exist or we may not have permissions; continue
  }

  // Read and execute the entire schema as one batch.
  // Running it as a single query preserves statement ordering so FK
  // references resolve correctly (e.g. connected_accounts → users).
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');

  try {
    await pool.query(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Skip "already exists" errors for idempotency
    if (!message.includes('already exists')) {
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
        await pool.query(stmt);
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
 * Roll back the initial migration: drop all tables in reverse dependency order.
 */
export async function down(): Promise<void> {
  const pool = getPool();

  const dropOrder = [
    // Added by migration 012 (mempalace)
    'entity_codes',
    'episodic_memories',
    'knowledge_triples',
    'knowledge_entities',
    'memory_tunnels',
    'memory_closets',
    'memory_drawers',
    'memory_rooms',
    'memory_wings',
    // Added by migrations 002–011 (reverse dependency order)
    'sessions',
    'ironclaw_tools',
    'preference_history',
    'escalation_triggers',
    'domain_autonomy_policies',
    'spend_records',
    'trust_tier_audit',
    'briefings',
    'proactive_scans',
    'skill_gap_log',
    'twin_exports',
    'preference_proposals',
    'signals',
    'accuracy_metrics',
    'eval_runs',
    'cross_domain_traits',
    'behavioral_patterns',
    'connector_configs',
    'oauth_tokens',
    // Base schema tables
    'execution_events',
    'feedback_events',
    'explanation_records',
    'execution_results',
    'execution_plans',
    'approval_requests',
    'decision_outcomes',
    'candidate_actions',
    'decisions',
    'action_policies',
    'preferences',
    'twin_profile_versions',
    'twin_profiles',
    'connected_accounts',
    'users',
  ];

  for (const table of dropOrder) {
    try {
      await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    } catch (error) {
      console.error(`[migration] Failed to drop table ${table}:`, error);
    }
  }

  console.log('[migration] 001-initial: All tables dropped.');
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
