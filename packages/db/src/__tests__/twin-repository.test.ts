import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { twinRepository } = await import('../repositories/twin-repository.js');

describe('twinRepository.isDraftsEnabled (#302)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the boolean column value from twin_profiles', async () => {
    mockQuery.mockResolvedValue({ rows: [{ drafts_enabled: true }], rowCount: 1 });
    expect(await twinRepository.isDraftsEnabled('u-1')).toBe(true);

    mockQuery.mockResolvedValue({ rows: [{ drafts_enabled: false }], rowCount: 1 });
    expect(await twinRepository.isDraftsEnabled('u-1')).toBe(false);
  });

  it('uses a narrow SELECT — no full profile fetch', async () => {
    // Pin the query shape: this runs on every signal ingest, so it
    // must be a single-column SELECT against the (user_id) unique
    // index, not a SELECT * that pulls 60kb of JSONB preferences.
    mockQuery.mockResolvedValue({ rows: [{ drafts_enabled: false }], rowCount: 1 });
    await twinRepository.isDraftsEnabled('u-1');
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('SELECT drafts_enabled');
    expect(sql).not.toContain('preferences');
    expect(params).toEqual(['u-1']);
  });

  it('returns FALSE (fail-closed) when no twin_profiles row exists yet', async () => {
    // The user hasn't been touched by getOrCreateProfile yet — a fresh
    // user mid-onboarding. The feature should stay off rather than
    // opening up because of a missing row. The default-DEFAULT-FALSE
    // column also guarantees this on the DB side once a row exists,
    // but this layer is the second line.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await twinRepository.isDraftsEnabled('u-new')).toBe(false);
  });
});

describe('twinRepository.setDraftsEnabled (#302)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flips the column via UPDATE ... RETURNING and returns the row', async () => {
    const row = {
      id: 'p-1',
      user_id: 'u-1',
      drafts_enabled: true,
    };
    mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

    const result = await twinRepository.setDraftsEnabled('u-1', true);
    expect(result).toEqual(row);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('UPDATE twin_profiles');
    expect(sql).toContain('SET drafts_enabled = $1');
    expect(sql).toContain('WHERE user_id = $2');
    expect(sql).toContain('RETURNING *');
    expect(params).toEqual([true, 'u-1']);
  });

  it('returns null when the user has no twin_profiles row to update', async () => {
    // Caller is expected to getOrCreateProfile first. Returning null
    // (rather than throwing) keeps the API ergonomic for the settings
    // route to handle "create-then-set" as a transactionless two-step.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await twinRepository.setDraftsEnabled('u-missing', true)).toBeNull();
  });

  it('also touches updated_at so the audit trail is meaningful', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'p-1' }], rowCount: 1 });
    await twinRepository.setDraftsEnabled('u-1', false);
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('updated_at = now()');
  });
});
