/**
 * E2E safety net for migration 061-cascade-cleanup.sql (#413).
 *
 * Verifies that every FK pointing at users(id) has ON DELETE CASCADE
 * after migrations run. Migration 061 assumes the CockroachDB default
 * constraint-name convention (`<table>_user_id_fkey`) — if a fork ever
 * adds a hand-named FK to users(id), the DROP CONSTRAINT IF EXISTS in
 * the migration will silently no-op and the cascade won't get applied.
 * This test will catch that drift.
 *
 * Also exercises the actual cascade behavior end-to-end on a
 * representative table (behavioral_patterns, which was one of the 32
 * that lacked cascade before #413) to prove the FK semantics — not
 * just the metadata flag — actually deletes child rows.
 *
 * Run via:  E2E=true pnpm --filter @skytwin/db exec vitest run src/__tests__/cascade-cleanup.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Pool } from 'pg';

const E2E = process.env['E2E'] === 'true';

let pool: Pool;
const createdUserIds: string[] = [];

interface RcRow {
  constraint_schema: string;
  table_name: string;
  constraint_name: string;
  delete_rule: string;
}

describe.skipIf(!E2E)('E2E: FK cascade cleanup (#413)', () => {
  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) throw new Error('DATABASE_URL must be set for E2E tests');
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      // Lean on the cascade we're testing — if it works, this single
      // DELETE collapses the user's full footprint.
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('every FK that references users(id) has ON DELETE CASCADE', async () => {
    // information_schema.referential_constraints joined to key_column_usage
    // surfaces the delete_rule + the referencing column — exactly the
    // shape we need to find non-cascading FKs to users(id).
    const result = await pool.query<RcRow>(
      `
      SELECT
        rc.constraint_schema,
        kcu.table_name,
        rc.constraint_name,
        rc.delete_rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = rc.constraint_name
       AND kcu.constraint_schema = rc.constraint_schema
      WHERE rc.unique_constraint_name IN (
        SELECT tc.constraint_name
          FROM information_schema.table_constraints tc
         WHERE tc.table_name = 'users'
           AND tc.constraint_type = 'PRIMARY KEY'
      )
      `,
    );

    const offenders = result.rows.filter((r) => r.delete_rule !== 'CASCADE');
    expect(
      offenders,
      `Found ${offenders.length} FK(s) to users(id) without CASCADE: ` +
        offenders.map((o) => `${o.table_name}.${o.constraint_name}`).join(', '),
    ).toEqual([]);

    // Sanity check: we should have a non-trivial number of cascading FKs.
    // If this drops to zero it means the query is wrong (schema drift
    // renamed a column or table), not that the codebase actually has
    // zero user-owned tables. Anchor on the floor we know exists.
    expect(result.rows.length).toBeGreaterThanOrEqual(30);
  });

  it('DELETE FROM users actually cascades to a child row on a previously-non-cascade table', async () => {
    // behavioral_patterns was on the migration-061 list. Pre-fix, a
    // DELETE FROM users would have failed with FK violation; post-fix,
    // the child row goes with the parent.
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, trust_tier, autonomy_settings)
       VALUES ($1, $2, 'observer', '{}')
       RETURNING id`,
      [`cascade-test-${Date.now()}@example.test`, 'Cascade Test'],
    );
    const userId = user.rows[0]!.id;
    createdUserIds.push(userId);

    await pool.query(
      `INSERT INTO behavioral_patterns
         (user_id, pattern_type, description, trigger_config, observed_action)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, 'test_pattern', 'cascade canary', '{}', 'noop'],
    );

    const beforeDelete = await pool.query(
      'SELECT 1 FROM behavioral_patterns WHERE user_id = $1',
      [userId],
    );
    expect(beforeDelete.rowCount).toBe(1);

    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    // Already handled by afterEach but we want to assert state now.
    createdUserIds.pop();

    const afterDelete = await pool.query(
      'SELECT 1 FROM behavioral_patterns WHERE user_id = $1',
      [userId],
    );
    expect(afterDelete.rowCount).toBe(0);
  });
});
