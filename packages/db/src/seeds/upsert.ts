/**
 * Shared idempotent upsert helper for seed/provision code (spec 10 Part B).
 *
 * `buildUpsertSql` is a pure SQL builder (no DB) so it can be unit-tested
 * deterministically; `seedUpsert` executes it against any Postgres-shaped
 * client. Used by the launch demo fixture (spec 09) and any seed path that must
 * be safe to run more than once. Identifiers are code-supplied (trusted) and
 * quoted; all VALUES are parameterized — never interpolate user data here.
 *
 * Note: the existing dev seed (`seed.ts`) already uses inline
 * `INSERT ... ON CONFLICT`, so it is already idempotent; this helper exists to
 * give new callers (spec 09) one shared, tested implementation rather than
 * re-deriving the ON CONFLICT SQL each time.
 */

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface UpsertSpec {
  /** Target table name (code-supplied, trusted). */
  table: string;
  /** Column → value map. Keys are column names (trusted); values are bound. */
  row: Record<string, unknown>;
  /** Conflict-target columns (the unique/pk columns). */
  conflict: string[];
  /**
   * On conflict: 'nothing' (DO NOTHING), 'all' (update every non-conflict
   * column), or an explicit list of columns to update. Defaults to 'all'.
   */
  update?: 'nothing' | 'all' | string[];
}

/** Quote a SQL identifier (double-quote, escape embedded quotes). */
function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/**
 * Build a parameterized `INSERT ... ON CONFLICT` statement. Pure — no DB.
 */
export function buildUpsertSql(spec: UpsertSpec): { text: string; values: unknown[] } {
  const columns = Object.keys(spec.row);
  if (columns.length === 0) {
    throw new Error(`seedUpsert: row for "${spec.table}" has no columns`);
  }
  if (spec.conflict.length === 0) {
    throw new Error(`seedUpsert: "${spec.table}" needs at least one conflict column`);
  }

  const values = columns.map((c) => spec.row[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const conflictCols = spec.conflict.map(quoteIdent).join(', ');

  const insert =
    `INSERT INTO ${quoteIdent(spec.table)} (${columns.map(quoteIdent).join(', ')}) ` +
    `VALUES (${placeholders.join(', ')})`;

  const mode = spec.update ?? 'all';
  let onConflict: string;
  if (mode === 'nothing') {
    onConflict = `ON CONFLICT (${conflictCols}) DO NOTHING`;
  } else {
    const updateCols =
      mode === 'all'
        ? columns.filter((c) => !spec.conflict.includes(c))
        : mode;
    if (updateCols.length === 0) {
      // Nothing left to update (all columns are conflict keys) — degrade to DO NOTHING.
      onConflict = `ON CONFLICT (${conflictCols}) DO NOTHING`;
    } else {
      const setClause = updateCols
        .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
        .join(', ');
      onConflict = `ON CONFLICT (${conflictCols}) DO UPDATE SET ${setClause}`;
    }
  }

  return { text: `${insert} ${onConflict}`, values };
}

/** Execute an idempotent upsert against a Postgres-shaped client. */
export async function seedUpsert(client: Queryable, spec: UpsertSpec): Promise<void> {
  const { text, values } = buildUpsertSql(spec);
  await client.query(text, values);
}
