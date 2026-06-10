import { describe, it, expect, vi } from 'vitest';
import { buildUpsertSql, seedUpsert, type Queryable } from '../seeds/upsert.js';

describe('buildUpsertSql (spec 10 Part B)', () => {
  it('builds a parameterized INSERT ... ON CONFLICT DO UPDATE (default mode)', () => {
    const { text, values } = buildUpsertSql({
      table: 'users',
      row: { id: 'u1', email: 'a@x.com', name: 'A' },
      conflict: ['id'],
    });
    expect(text).toBe(
      'INSERT INTO "users" ("id", "email", "name") VALUES ($1, $2, $3) ' +
        'ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email", "name" = EXCLUDED."name"',
    );
    expect(values).toEqual(['u1', 'a@x.com', 'A']);
  });

  it('supports DO NOTHING', () => {
    const { text } = buildUpsertSql({
      table: 'twin_profiles',
      row: { user_id: 'u1', version: 1 },
      conflict: ['user_id'],
      update: 'nothing',
    });
    expect(text).toContain('ON CONFLICT ("user_id") DO NOTHING');
    expect(text).not.toContain('DO UPDATE');
  });

  it('supports an explicit update-column subset', () => {
    const { text } = buildUpsertSql({
      table: 't',
      row: { id: 1, a: 2, b: 3, c: 4 },
      conflict: ['id'],
      update: ['a', 'c'],
    });
    expect(text).toContain('DO UPDATE SET "a" = EXCLUDED."a", "c" = EXCLUDED."c"');
    expect(text).not.toContain('"b" = EXCLUDED."b"');
  });

  it('degrades to DO NOTHING when every column is a conflict key', () => {
    const { text } = buildUpsertSql({
      table: 'link',
      row: { left_id: 'l', right_id: 'r' },
      conflict: ['left_id', 'right_id'],
    });
    expect(text).toContain('DO NOTHING');
  });

  it('quotes identifiers and escapes embedded quotes (injection-resistant identifiers)', () => {
    const { text } = buildUpsertSql({
      table: 'we"ird',
      row: { 'co"l': 1 },
      conflict: ['co"l'],
    });
    expect(text).toContain('"we""ird"');
    expect(text).toContain('"co""l"');
  });

  it('throws on empty row or empty conflict set', () => {
    expect(() => buildUpsertSql({ table: 't', row: {}, conflict: ['id'] })).toThrow();
    expect(() => buildUpsertSql({ table: 't', row: { id: 1 }, conflict: [] })).toThrow();
  });
});

describe('seedUpsert execution', () => {
  it('executes the built SQL against the client with bound values', async () => {
    const client: Queryable = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await seedUpsert(client, {
      table: 'users',
      row: { id: 'u1', email: 'a@x.com' },
      conflict: ['id'],
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0] as string).toContain('INSERT INTO "users"');
    expect(call[1]).toEqual(['u1', 'a@x.com']);
  });

  it('is safe to call repeatedly with the same row (idempotent by construction)', async () => {
    const client: Queryable = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const spec = { table: 'users', row: { id: 'u1' }, conflict: ['id'], update: 'nothing' as const };
    await seedUpsert(client, spec);
    await seedUpsert(client, spec);
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    const sql0 = calls[0]![0] as string;
    const sql1 = calls[1]![0] as string;
    expect(sql0).toBe(sql1); // identical idempotent statement
    expect(sql0).toContain('DO NOTHING');
  });
});
