/**
 * Schema ⇄ TS enum drift guard.
 *
 * The #567 incident: a value (`noted_awareness`) was added to the
 * `MemoryActionOpportunityStatus` TS union and wired through every consumer, but
 * the matching CockroachDB `CHECK` constraint was not updated — so the full test
 * suite passed (every repository test mocks the query layer) while production
 * rejected the write. This static guard closes that class: for each
 * CHECK-constrained enum column it parses the TS union members from source AND
 * the allowed values from `schemas/schema.sql`, and fails if they disagree —
 * pointing you at the missing migration before it ships.
 *
 * It reads source (not a built artifact) so it runs in the default `vitest`
 * suite with no database. Add a CASE whenever you add a CHECK-constrained enum.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8');
const SCHEMA = read('../schemas/schema.sql');

/** String-literal members of `export type Name = 'a' | 'b' | …;`, comments stripped. */
function tsUnionMembers(source: string, typeName: string): string[] {
  const m = source.match(new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`));
  if (!m) throw new Error(`TS union '${typeName}' not found`);
  const body = m[1]!
    .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments (may contain apostrophes)
    .replace(/\/\/.*$/gm, ''); // strip line comments
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** Allowed values of `CHECK (<column> IN (…))` within a given table's definition. */
function checkConstraintValues(table: string, column: string): string[] {
  const chunk = SCHEMA.split(/CREATE TABLE/i).find((c) =>
    new RegExp(`^[^(]*\\b${table}\\b`, 'i').test(c.trimStart()),
  );
  if (!chunk) throw new Error(`table '${table}' not found in schema.sql`);
  const m = chunk.match(new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([\\s\\S]*?)\\)\\s*\\)`, 'i'));
  if (!m) throw new Error(`CHECK (${column} IN …) not found on table '${table}'`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

interface Case {
  unionFile: string;
  unionName: string;
  table: string;
  column: string;
}

// One entry per CHECK-constrained enum column. Add to this list when you add a
// new persisted status/enum so the constraint can't drift from the TS union.
const CASES: Case[] = [
  {
    unionFile: '../../../shared-types/src/memory-action-loop.ts',
    unionName: 'MemoryActionOpportunityStatus',
    table: 'memory_action_opportunities',
    column: 'status',
  },
  {
    unionFile: '../../../shared-types/src/action-safety.ts',
    unionName: 'ActionProvenance',
    table: 'memory_action_opportunities',
    column: 'provenance',
  },
];

describe('schema ⇄ TS enum drift guard', () => {
  it.each(CASES)('$unionName matches the $table.$column CHECK constraint', (c) => {
    const tsMembers = [...tsUnionMembers(read(c.unionFile), c.unionName)].sort();
    const sqlValues = [...checkConstraintValues(c.table, c.column)].sort();

    const missingFromDb = tsMembers.filter((v) => !sqlValues.includes(v));
    const missingFromTs = sqlValues.filter((v) => !tsMembers.includes(v));

    expect(
      missingFromDb,
      `${c.unionName} has values absent from ${c.table}.${c.column} CHECK: [${missingFromDb.join(', ')}]. ` +
        `Add a migration that ALTERs the constraint AND update schemas/schema.sql.`,
    ).toEqual([]);
    expect(
      missingFromTs,
      `${c.table}.${c.column} CHECK allows values not in ${c.unionName}: [${missingFromTs.join(', ')}].`,
    ).toEqual([]);
  });

  it('actually detects drift (self-test of the guard logic)', () => {
    const sqlValues = checkConstraintValues('memory_action_opportunities', 'status');
    const driftedTs = [...sqlValues, 'a_value_not_in_the_db_constraint'];
    const missingFromDb = driftedTs.filter((v) => !sqlValues.includes(v));
    expect(missingFromDb).toEqual(['a_value_not_in_the_db_constraint']);
  });
});
