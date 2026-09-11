import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { sourceKeyRegistryRepository } = await import('../repositories/source-key-registry-repository.js');
const input = {
  user_id: '00000000-0000-4000-8000-000000000001',
  key_version: 1,
  wrapper_version: 1,
  algorithm: 'aes-256-gcm' as const,
  kdf_record: { algorithm: 'scrypt' },
  recovery_wrapper: { magic: 'skytwin-user-key' },
};

describe('sourceKeyRegistryRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads only the newest active wrapper for one user', async () => {
    const row = { ...input, created_at: new Date(), retired_at: null };
    mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });
    expect(await sourceKeyRegistryRepository.getCurrent(input.user_id)).toEqual(row);
    expect(mockQuery.mock.calls[0]![0]).toContain('WHERE user_id = $1 AND retired_at IS NULL');
    expect(mockQuery.mock.calls[0]![1]).toEqual([input.user_id]);
  });

  it('atomically creates an initial wrapper and refuses a conflicting version', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: input.user_id }], rowCount: 1 });
    expect(await sourceKeyRegistryRepository.createInitial(input)).toBe(true);
    expect(mockQuery.mock.calls[0]![0]).toContain('ON CONFLICT (user_id, key_version) DO NOTHING');
    expect(mockQuery.mock.calls[0]![0]).toContain('WHERE user_id = $1 AND retired_at IS NULL');
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await sourceKeyRegistryRepository.createInitial(input)).toBe(false);
  });

  it('persists a retryable device-wrapper deletion intent', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await sourceKeyRegistryRepository.requestDeletion(input.user_id);
    expect(mockQuery.mock.calls[0]![0]).toContain('UPSERT INTO source_key_deletion_intents');
    expect(mockQuery.mock.calls[0]![1]).toEqual([input.user_id]);
  });

  it('deletes only an exact active version during failed initialization rollback', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    expect(await sourceKeyRegistryRepository.deleteVersion(input.user_id, 1)).toBe(true);
    expect(mockQuery.mock.calls[0]![0]).toContain('user_id = $1 AND key_version = $2 AND retired_at IS NULL');
    expect(mockQuery.mock.calls[0]![1]).toEqual([input.user_id, 1]);
  });
});
