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
});

describe('isIdempotentError', () => {
  it('matches SQLSTATE codes for already-exists conditions', () => {
    expect(isIdempotentError({ code: '42710' })).toBe(true); // duplicate_object
    expect(isIdempotentError({ code: '42P07' })).toBe(true); // duplicate_table
    expect(isIdempotentError({ code: '42701' })).toBe(true); // duplicate_column
    expect(isIdempotentError({ code: '23505' })).toBe(true); // unique_violation
  });

  it('falls back to message substrings when no code is present', () => {
    expect(isIdempotentError(new Error('relation "users" already exists'))).toBe(true);
    expect(isIdempotentError(new Error('duplicate constraint name: "cpn_check"'))).toBe(true);
    expect(isIdempotentError(new Error('duplicate column name "email"'))).toBe(true);
    expect(isIdempotentError(new Error('duplicate key value'))).toBe(true);
  });

  it('does not treat real failures as idempotent', () => {
    expect(isIdempotentError({ code: '42601' })).toBe(false); // syntax_error
    expect(isIdempotentError(new Error('syntax error at or near "EOF"'))).toBe(false);
    expect(isIdempotentError(new Error('relation "users" does not exist'))).toBe(false);
    expect(isIdempotentError('some string error')).toBe(false);
    expect(isIdempotentError(null)).toBe(false);
  });
});
