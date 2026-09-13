/**
 * Destructive migration rollback coverage. Run only against a disposable DB:
 * E2E=true MIGRATION_ROLLBACK_E2E=true pnpm --filter @skytwin/db exec vitest run \
 *   src/__tests__/migration-rollback.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool } from '../connection.js';
import { down, up } from '../migrations/001-initial.js';

const ENABLED = process.env['E2E'] === 'true' &&
  process.env['MIGRATION_ROLLBACK_E2E'] === 'true';

let pool: Pool;

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

  it('drops and recreates admission barriers with every authority FK intact', async () => {
    await up();
    expect(await admissionForeignKeys()).toEqual([
      { column_name: 'action_id', foreign_table_name: 'candidate_actions', delete_rule: 'NO ACTION' },
      { column_name: 'decision_id', foreign_table_name: 'decisions', delete_rule: 'NO ACTION' },
      { column_name: 'execution_plan_id', foreign_table_name: 'execution_plans', delete_rule: 'NO ACTION' },
      { column_name: 'user_id', foreign_table_name: 'users', delete_rule: 'CASCADE' },
    ]);

    await down();
    const dropped = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'execution_admission_barriers'`,
    );
    expect(dropped.rowCount).toBe(0);

    await up();
    expect(await admissionForeignKeys()).toEqual([
      { column_name: 'action_id', foreign_table_name: 'candidate_actions', delete_rule: 'NO ACTION' },
      { column_name: 'decision_id', foreign_table_name: 'decisions', delete_rule: 'NO ACTION' },
      { column_name: 'execution_plan_id', foreign_table_name: 'execution_plans', delete_rule: 'NO ACTION' },
      { column_name: 'user_id', foreign_table_name: 'users', delete_rule: 'CASCADE' },
    ]);
  }, 600_000);
});
