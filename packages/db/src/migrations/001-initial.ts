import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, '..', 'schemas', 'schema.sql');

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
    const statements = sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => {
        // Keep blocks that contain at least one non-comment SQL line
        const sqlLines = s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
        return sqlLines.length > 0;
      });

    let applied = 0;
    for (const stmt of statements) {
      try {
        await pool.query(stmt);
        applied++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('already exists') ||
          message.includes('duplicate key') ||
          message.includes('duplicate column name')
        ) {
          // Idempotent — skip
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
