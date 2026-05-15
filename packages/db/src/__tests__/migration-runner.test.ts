import { describe, it, expect } from 'vitest';
import { splitSqlStatements, isIdempotentError } from '../migrations/001-initial.js';

describe('splitSqlStatements', () => {
  it('splits statements on end-of-line semicolons', () => {
    const sql = 'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\n';
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE a (id INT)',
      'CREATE TABLE b (id INT)',
    ]);
  });

  it('does not split on a semicolon inside a -- comment', () => {
    // Regression: migration 039 had `;` at the end of a comment line,
    // which split the CREATE TABLE in half and produced a syntax error.
    const sql = [
      'CREATE TABLE model_downloads (',
      '  id UUID PRIMARY KEY,',
      '  -- total bytes (corrected on first response; see below)',
      '  total_bytes INT8 NOT NULL',
      ');',
    ].join('\n');
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE model_downloads (\n  id UUID PRIMARY KEY,\n  \n  total_bytes INT8 NOT NULL\n)',
    ]);
  });

  it('drops comment-only and empty blocks', () => {
    const sql = '-- a leading comment\n\nCREATE TABLE a (id INT);\n-- trailing\n';
    expect(splitSqlStatements(sql)).toEqual(['CREATE TABLE a (id INT)']);
  });

  it('strips trailing line comments from a statement', () => {
    const sql = 'CREATE INDEX i ON a (id); -- speeds up lookups\n';
    expect(splitSqlStatements(sql)).toEqual(['CREATE INDEX i ON a (id)']);
  });

  it('returns no statements for an all-comment file', () => {
    expect(splitSqlStatements('-- just a header\n-- nothing else\n')).toEqual([]);
  });

  it('passes statements with balanced string literals through unchanged', () => {
    const sql = "INSERT INTO t (name) VALUES ('hello');\n";
    expect(splitSqlStatements(sql)).toEqual(["INSERT INTO t (name) VALUES ('hello')"]);
  });

  it('throws if comment-strip corrupts a string literal (unbalanced quotes)', () => {
    // `--b')` is inside a string literal; the non-string-aware strip
    // eats it, leaving an unbalanced quote — must fail loud, not corrupt.
    const sql = "INSERT INTO t (v) VALUES ('a--b');\n";
    expect(() => splitSqlStatements(sql)).toThrow(/unbalanced single-quotes/);
  });
});

describe('isIdempotentError', () => {
  it('matches SQLSTATE codes for DDL already-exists conditions', () => {
    expect(isIdempotentError({ code: '42710' })).toBe(true); // duplicate_object
    expect(isIdempotentError({ code: '42P07' })).toBe(true); // duplicate_table
    expect(isIdempotentError({ code: '42701' })).toBe(true); // duplicate_column
  });

  it('falls back to message substrings for DDL already-exists conditions', () => {
    expect(isIdempotentError(new Error('relation "users" already exists'))).toBe(true);
    expect(isIdempotentError(new Error('duplicate constraint name: "cpn_check"'))).toBe(true);
    expect(isIdempotentError(new Error('duplicate column name "email"'))).toBe(true);
  });

  it('does not treat real failures as idempotent', () => {
    expect(isIdempotentError({ code: '42601' })).toBe(false); // syntax_error
    expect(isIdempotentError(new Error('syntax error at or near "EOF"'))).toBe(false);
    expect(isIdempotentError(new Error('relation "users" does not exist'))).toBe(false);
    expect(isIdempotentError('some string error')).toBe(false);
    expect(isIdempotentError(null)).toBe(false);
  });

  // 23505 / "duplicate key" is NEVER idempotent-safe at the runner level.
  // Earlier versions swallowed 23505 to make re-running a seed INSERT a
  // no-op, but the carve-out also masked real failures: a CREATE UNIQUE
  // INDEX blocked by residual duplicates, an INSERT ... SELECT backfill
  // hitting a real collision, an ALTER TABLE ... ADD CONSTRAINT UNIQUE
  // failing on dirty data — all of those returned 23505 and were silently
  // absorbed. Migration 046 (the approval_requests unique index) was the
  // case that surfaced this. The runner now has one rule: 23505 always
  // surfaces. Seed migrations that need re-run safety use
  // `INSERT ... ON CONFLICT DO NOTHING` to mark the intent explicitly.
  describe('unique violation (23505 / "duplicate key")', () => {
    it('always surfaces 23505 regardless of statement shape', () => {
      // The carve-out is gone — no statement parameter, no INSERT
      // heuristic. Every 23505 reaches the migration runner's catch.
      expect(isIdempotentError({ code: '23505' })).toBe(false);
      expect(
        isIdempotentError(new Error('duplicate key value violates unique constraint "users_pkey"')),
      ).toBe(false);
      expect(isIdempotentError(new Error('duplicate key value'))).toBe(false);
    });

    it('surfaces 23505 even when the message happens to contain "already exists"', () => {
      // Some driver variants append "already exists" to a 23505 message.
      // The code-anchored 23505 guard runs BEFORE the DDL message-
      // substring fallback, so the function returns false on this shape.
      // (Using a real Error rather than a plain object so the message
      // would in principle be reachable — without the guard, this exact
      // shape would have been swallowed by `message.includes('already
      // exists')`. The guard is what makes the test pass.)
      const err = Object.assign(
        new Error('unique index "idx_t_k" already exists with duplicate data'),
        { code: '23505' },
      );
      expect(isIdempotentError(err)).toBe(false);
    });

    it('surfaces 23505 when the driver returns the code as a number', () => {
      // node-postgres always stringifies, but other pg clients (or a
      // hand-built driver) may surface `code` as a JS number. The guard
      // uses `String(code) === '23505'` so the value matches regardless
      // of which JS type carries it. Without this, a numeric-coded 23505
      // with "already exists" in its message would fall through to the
      // DDL substring fallback and be silently swallowed.
      const err = Object.assign(
        new Error('unique index "idx_t_k" already exists with duplicate data'),
        { code: 23505 },
      );
      expect(isIdempotentError(err)).toBe(false);
      expect(isIdempotentError({ code: 23505 })).toBe(false);
    });

    it('surfaces a 23505-shaped error even when the driver elides `code`', () => {
      // Belt-and-suspenders: a driver that drops `code` on a 23505 still
      // carries the canonical "duplicate key value" message. The guard
      // vetoes that substring before the DDL fallback can pick it up,
      // so the function never absorbs a duplicate-key error just because
      // its code field was missing.
      const err = new Error(
        'duplicate key value violates unique constraint "idx_t_k"',
      );
      expect(isIdempotentError(err)).toBe(false);
    });

    it('still surfaces 23505 even when its message *only* says "already exists"', () => {
      // Defends the "code-anchored guard runs before message fallback"
      // ordering: a 23505 whose message says nothing about duplicate
      // keys and only says "already exists" (a hypothetical driver
      // variant) must still surface, because the code is what tells us
      // the operation actually failed on data — not on a name clash.
      const err = Object.assign(
        new Error('relation "idx_t_k" already exists'),
        { code: '23505' },
      );
      expect(isIdempotentError(err)).toBe(false);
    });
  });
});
