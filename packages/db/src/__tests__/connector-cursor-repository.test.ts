import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { connectorCursorRepository } = await import(
  '../repositories/connector-cursor-repository.js'
);

describe('connectorCursorRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('get() returns null when no row exists', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await connectorCursorRepository.get('u-1', 'gmail', 'history_id');
    expect(result).toBeNull();
  });

  it('get() returns the row keyed on (user_id, provider, cursor_kind)', async () => {
    const row = {
      user_id: 'u-1',
      provider: 'gmail',
      cursor_kind: 'history_id',
      cursor_value: '12345',
      updated_at: new Date('2026-04-28'),
    };
    mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

    const result = await connectorCursorRepository.get('u-1', 'gmail', 'history_id');

    expect(result).toEqual(row);
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('WHERE user_id = $1 AND provider = $2 AND cursor_kind = $3');
    expect(args).toEqual(['u-1', 'gmail', 'history_id']);
  });

  it('save() upserts on (user_id, provider, cursor_kind)', async () => {
    const row = {
      user_id: 'u-1',
      provider: 'gmail',
      cursor_kind: 'history_id',
      cursor_value: '67890',
      updated_at: new Date('2026-04-28'),
    };
    mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

    await connectorCursorRepository.save('u-1', 'gmail', 'history_id', '67890');

    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('ON CONFLICT (user_id, provider, cursor_kind)');
    expect(sql).toContain('DO UPDATE SET');
    expect(args).toEqual(['u-1', 'gmail', 'history_id', '67890']);
  });

  it('delete() returns true when a row was removed', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const result = await connectorCursorRepository.delete('u-1', 'gmail', 'history_id');
    expect(result).toBe(true);
  });

  it('delete() returns false when no row matched', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await connectorCursorRepository.delete('u-1', 'gmail', 'history_id');
    expect(result).toBe(false);
  });

  it('delete() returns false when rowCount is null', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: null });
    const result = await connectorCursorRepository.delete('u-1', 'gmail', 'history_id');
    expect(result).toBe(false);
  });
});
