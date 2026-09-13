/**
 * Destructive migration rollback coverage. Run only against a disposable DB:
 * E2E=true MIGRATION_ROLLBACK_E2E=true pnpm --filter @skytwin/db exec vitest run \
 *   src/__tests__/migration-rollback.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool } from '../connection.js';
import { down, getSkyTwinOwnedTableManifest, up } from '../migrations/001-initial.js';
import { SKYTWIN_OWNED_TABLES } from './fixtures/skytwin-owned-tables.js';

const ENABLED = process.env['E2E'] === 'true' &&
  process.env['MIGRATION_ROLLBACK_E2E'] === 'true';

let pool: Pool;

interface SemanticConstraint {
  table_name: string;
  constraint_type: string;
  definition: string;
}

const OWNED = [...SKYTWIN_OWNED_TABLES];

async function semanticConstraints(): Promise<SemanticConstraint[]> {
  const result = await pool.query<SemanticConstraint>(`
    WITH key_constraints AS (
      SELECT tc.table_name,
             tc.constraint_type,
             string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS definition
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_catalog = tc.constraint_catalog
         AND kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
       WHERE tc.constraint_schema = 'public' AND tc.table_name = ANY($1::STRING[])
         AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
       GROUP BY tc.table_name, tc.constraint_type, tc.constraint_name
    ), foreign_keys AS (
      SELECT tc.table_name,
             'FOREIGN KEY' AS constraint_type,
             string_agg(
               kcu.column_name || '->' || referenced.table_name || '.' || referenced.column_name,
               ',' ORDER BY kcu.ordinal_position
             ) || '|DELETE ' || rc.delete_rule || '|UPDATE ' || rc.update_rule AS definition
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_catalog = tc.constraint_catalog
         AND kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_catalog = tc.constraint_catalog
         AND rc.constraint_schema = tc.constraint_schema
         AND rc.constraint_name = tc.constraint_name
        JOIN information_schema.key_column_usage referenced
          ON referenced.constraint_catalog = rc.unique_constraint_catalog
         AND referenced.constraint_schema = rc.unique_constraint_schema
         AND referenced.constraint_name = rc.unique_constraint_name
         AND referenced.ordinal_position = kcu.position_in_unique_constraint
       WHERE tc.constraint_schema = 'public' AND tc.table_name = ANY($1::STRING[])
         AND tc.constraint_type = 'FOREIGN KEY'
       GROUP BY tc.table_name, tc.constraint_name, rc.delete_rule, rc.update_rule
    ), checks AS (
      SELECT tc.table_name,
             'CHECK' AS constraint_type,
             cc.check_clause AS definition
        FROM information_schema.table_constraints tc
        JOIN information_schema.check_constraints cc
          ON cc.constraint_catalog = tc.constraint_catalog
         AND cc.constraint_schema = tc.constraint_schema
         AND cc.constraint_name = tc.constraint_name
       WHERE tc.constraint_schema = 'public' AND tc.table_name = ANY($1::STRING[])
         AND tc.constraint_type = 'CHECK'
    )
    SELECT table_name, constraint_type, definition FROM key_constraints
    UNION ALL
    SELECT table_name, constraint_type, definition FROM foreign_keys
    UNION ALL
    SELECT table_name, constraint_type, definition FROM checks
    ORDER BY table_name, constraint_type, definition
  `, [OWNED]);
  return result.rows;
}

interface ColumnDefinition {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string;
  is_generated: string;
  generation_expression: string;
}

async function columnDefinitions(): Promise<ColumnDefinition[]> {
  const result = await pool.query<ColumnDefinition>(`
    SELECT table_name, column_name, ordinal_position::INT,
           data_type, udt_name, is_nullable,
           COALESCE(column_default, '') AS column_default,
           COALESCE(is_generated, '') AS is_generated,
           COALESCE(generation_expression, '') AS generation_expression
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::STRING[])
     ORDER BY table_name, ordinal_position
  `, [OWNED]);
  return result.rows.map((row) => ({
    ...row,
    column_default: row.column_default.replace(/\s+/g, ' ').trim(),
    generation_expression: row.generation_expression.replace(/\s+/g, ' ').trim(),
  }));
}

interface IndexDefinition {
  tablename: string;
  indexname: string;
  indexdef: string;
}

async function indexDefinitions(): Promise<IndexDefinition[]> {
  const result = await pool.query<IndexDefinition>(`
    SELECT tablename, indexname, indexdef
      FROM pg_catalog.pg_indexes
     WHERE schemaname = 'public' AND tablename = ANY($1::STRING[])
     ORDER BY tablename, indexname
  `, [OWNED]);
  return result.rows.map((row) => ({
    ...row,
    indexdef: row.indexdef.replace(/\s+/g, ' ').trim(),
  }));
}

async function ownedTables(): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name = ANY($1::STRING[])
      ORDER BY table_name`,
    [OWNED],
  );
  return result.rows.map(({ table_name: tableName }) => tableName);
}

async function admissionForeignKeys(): Promise<Array<{
  column_name: string;
  foreign_table_name: string;
  delete_rule: string;
}>> {
  const result = await pool.query<{
    column_name: string;
    foreign_table_name: string;
    delete_rule: string;
  }>(`
    SELECT kcu.column_name,
           ccu.table_name AS foreign_table_name,
           rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_catalog = tc.constraint_catalog
       AND kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_catalog = tc.constraint_catalog
       AND rc.constraint_schema = tc.constraint_schema
       AND rc.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_catalog = rc.unique_constraint_catalog
       AND ccu.constraint_schema = rc.unique_constraint_schema
       AND ccu.constraint_name = rc.unique_constraint_name
     WHERE tc.table_name = 'execution_admission_barriers'
       AND tc.constraint_type = 'FOREIGN KEY'
     ORDER BY kcu.column_name
  `);
  return result.rows;
}

async function memoryActionForeignKeys(): Promise<Array<{
  column_name: string;
  foreign_table_name: string;
  delete_rule: string;
}>> {
  const result = await pool.query<{
    column_name: string;
    foreign_table_name: string;
    delete_rule: string;
  }>(`
    SELECT kcu.column_name,
           ccu.table_name AS foreign_table_name,
           rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_catalog = tc.constraint_catalog
       AND kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_catalog = tc.constraint_catalog
       AND rc.constraint_schema = tc.constraint_schema
       AND rc.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_catalog = rc.unique_constraint_catalog
       AND ccu.constraint_schema = rc.unique_constraint_schema
       AND ccu.constraint_name = rc.unique_constraint_name
     WHERE tc.table_name = 'memory_action_opportunities'
       AND tc.constraint_type = 'FOREIGN KEY'
     ORDER BY kcu.column_name
  `);
  return result.rows;
}

async function stackForeignKeys(): Promise<Array<{
  table_name: string;
  constraint_name: string;
  delete_rule: string;
}>> {
  const result = await pool.query<{
    table_name: string;
    constraint_name: string;
    delete_rule: string;
  }>(`
    SELECT tc.table_name, tc.constraint_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_catalog = tc.constraint_catalog
       AND rc.constraint_schema = tc.constraint_schema
       AND rc.constraint_name = tc.constraint_name
     WHERE tc.table_name IN (
       'inference_receipts',
       'inference_receipt_completions',
       'decision_ingest_guards'
     )
       AND tc.constraint_type = 'FOREIGN KEY'
     ORDER BY tc.table_name, tc.constraint_name
  `);
  return result.rows;
}

const EXPECTED_STACK_FOREIGN_KEYS = [
  {
    table_name: 'decision_ingest_guards',
    constraint_name: 'decision_ingest_guards_decision_id_fkey',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'decision_ingest_guards',
    constraint_name: 'decision_ingest_guards_receipt_explanation_fk',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'inference_receipt_completions',
    constraint_name: 'inference_receipt_completions_decision_id_fkey',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'inference_receipt_completions',
    constraint_name: 'inference_receipt_completions_explanation_decision_fk',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'inference_receipts',
    constraint_name: 'inference_receipts_decision_id_fkey',
    delete_rule: 'CASCADE',
  },
  {
    table_name: 'inference_receipts',
    constraint_name: 'inference_receipts_explanation_decision_fk',
    delete_rule: 'CASCADE',
  },
];

describe.skipIf(!ENABLED)('E2E: migration rollback and reapply', () => {
  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) throw new Error('DATABASE_URL must be set for migration rollback E2E');
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
    await closePool();
  });

  it('preserves foreign tables and recreates the owned structural schema', async () => {
    expect(getSkyTwinOwnedTableManifest().current).toEqual(OWNED);
    expect(await ownedTables()).toEqual([]);
    await pool.query('CREATE TABLE operator_rollback_sentinel (id UUID PRIMARY KEY)');

    try {
    await up();
    expect(await ownedTables()).toEqual(OWNED);
    const expectedColumns = await columnDefinitions();
    const expectedConstraints = await semanticConstraints();
    const expectedIndexes = await indexDefinitions();
    await pool.query(`
      CREATE TABLE operator_fk_sentinel (
        id UUID PRIMARY KEY,
        skytwin_user_id UUID REFERENCES users(id)
      );
      CREATE VIEW operator_user_view AS SELECT id FROM users;
    `);
    await expect(down()).rejects.toThrow(/operator-owned objects depend on SkyTwin tables/);
    expect(await ownedTables()).toEqual(OWNED);
    expect(await pool.query(
      `SELECT 1 FROM information_schema.table_constraints
       WHERE table_name = 'operator_fk_sentinel' AND constraint_type = 'FOREIGN KEY'`,
    )).toMatchObject({ rowCount: 1 });
    expect(await pool.query(
      `SELECT 1 FROM information_schema.views WHERE table_name = 'operator_user_view'`,
    )).toMatchObject({ rowCount: 1 });
    await pool.query('DROP VIEW operator_user_view');
    await pool.query('DROP TABLE operator_fk_sentinel');
    // This name belonged to an old SkyTwin migration, but is no longer in the
    // current manifest. Reuse by an operator must not be mistaken for ownership.
    await pool.query('CREATE TABLE capability_recipes (operator_value STRING)');
    expect(await stackForeignKeys()).toEqual(EXPECTED_STACK_FOREIGN_KEYS);
    expect(await admissionForeignKeys()).toEqual(expect.arrayContaining([
      { column_name: 'outcome_id', foreign_table_name: 'decision_outcomes', delete_rule: 'NO ACTION' },
      { column_name: 'explanation_id', foreign_table_name: 'explanation_records', delete_rule: 'NO ACTION' },
      { column_name: 'user_id', foreign_table_name: 'users', delete_rule: 'CASCADE' },
    ]));
    expect(await memoryActionForeignKeys()).toEqual([
      { column_name: 'approval_request_id', foreign_table_name: 'approval_requests', delete_rule: 'SET NULL' },
      { column_name: 'decision_id', foreign_table_name: 'decisions', delete_rule: 'SET NULL' },
      { column_name: 'execution_plan_id', foreign_table_name: 'execution_plans', delete_rule: 'SET NULL' },
      { column_name: 'user_id', foreign_table_name: 'users', delete_rule: 'CASCADE' },
    ]);

    await down();
    expect(await ownedTables()).toEqual([]);
    expect(await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'operator_rollback_sentinel'`,
    )).toMatchObject({ rowCount: 1 });
    expect(await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'capability_recipes'`,
    )).toMatchObject({ rowCount: 1 });

    await up();
    expect(await ownedTables()).toEqual(OWNED);
    expect(await columnDefinitions()).toEqual(expectedColumns);
    expect(await semanticConstraints()).toEqual(expectedConstraints);
    expect(await indexDefinitions()).toEqual(expectedIndexes);
    expect(await stackForeignKeys()).toEqual(EXPECTED_STACK_FOREIGN_KEYS);
    expect(await admissionForeignKeys()).toEqual(expect.arrayContaining([
      { column_name: 'outcome_id', foreign_table_name: 'decision_outcomes', delete_rule: 'NO ACTION' },
      { column_name: 'explanation_id', foreign_table_name: 'explanation_records', delete_rule: 'NO ACTION' },
      { column_name: 'user_id', foreign_table_name: 'users', delete_rule: 'CASCADE' },
    ]));
    expect(await memoryActionForeignKeys()).toEqual([
      { column_name: 'approval_request_id', foreign_table_name: 'approval_requests', delete_rule: 'SET NULL' },
      { column_name: 'decision_id', foreign_table_name: 'decisions', delete_rule: 'SET NULL' },
      { column_name: 'execution_plan_id', foreign_table_name: 'execution_plans', delete_rule: 'SET NULL' },
      { column_name: 'user_id', foreign_table_name: 'users', delete_rule: 'CASCADE' },
    ]);
    } finally {
      await pool.query('DROP VIEW IF EXISTS operator_user_view');
      await pool.query('DROP TABLE IF EXISTS operator_fk_sentinel');
      await down();
      await pool.query('DROP TABLE IF EXISTS operator_rollback_sentinel');
      await pool.query('DROP TABLE IF EXISTS capability_recipes');
    }
  }, 600_000);
});
