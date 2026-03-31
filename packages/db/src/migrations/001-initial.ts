import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, '..', 'schemas', 'schema.sql');

/**
 * Run the initial migration: create all tables from schema.sql.
 */
export async function up(): Promise<void> {
  const pool = getPool();

  // Ensure the database exists
  try {
    await pool.query('CREATE DATABASE IF NOT EXISTS skytwin');
  } catch {
    // Database may already exist or we may not have permissions; continue
  }

  // Read and execute the schema
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');

  // Split on semicolons but respect multi-line statements
  const statements = schema
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Skip "already exists" errors for idempotency
      if (!message.includes('already exists')) {
        console.error(`[migration] Failed to execute statement:`);
        console.error(statement.substring(0, 200));
        throw error;
      }
    }
  }

  console.log('[migration] 001-initial: All tables created successfully.');
}

/**
 * Roll back the initial migration: drop all tables in reverse dependency order.
 */
export async function down(): Promise<void> {
  const pool = getPool();

  const dropOrder = [
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

main();
