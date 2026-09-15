import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { sourceKeyRegistryRepository, SourceKeyRegistryConflictError } =
  await import('../repositories/source-key-registry-repository.js');
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

  it('normalizes pg INT8 strings and reads at most one active initial wrapper', async () => {
    const created = new Date();
    mockQuery.mockResolvedValue({ rows: [{
      ...input,
      key_version: '1',
      wrapper_version: '1',
      created_at: created.toISOString(),
      retired_at: null,
    }], rowCount: 1 });
    expect(await sourceKeyRegistryRepository.getCurrent(input.user_id)).toEqual({
      ...input,
      created_at: created,
      retired_at: null,
    });
    expect(mockQuery.mock.calls[0]![0]).toContain('LIMIT 2');
    expect(mockQuery.mock.calls[0]![1]).toEqual([input.user_id]);
  });

  it('fails closed on multiple active, unsupported, or malformed rows', async () => {
    const row = { ...input, created_at: new Date(), retired_at: null };
    mockQuery.mockResolvedValueOnce({ rows: [row, { ...row, key_version: '2' }], rowCount: 2 });
    await expect(sourceKeyRegistryRepository.getCurrent(input.user_id))
      .rejects.toBeInstanceOf(SourceKeyRegistryConflictError);
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, key_version: '2' }], rowCount: 1 });
    await expect(sourceKeyRegistryRepository.getCurrent(input.user_id))
      .rejects.toBeInstanceOf(SourceKeyRegistryConflictError);
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, key_version: '01' }], rowCount: 1 });
    await expect(sourceKeyRegistryRepository.getCurrent(input.user_id))
      .rejects.toBeInstanceOf(SourceKeyRegistryConflictError);
  });

  it('atomically creates only the initial wrapper for a user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: input.user_id }], rowCount: 1 });
    expect(await sourceKeyRegistryRepository.createInitial(input)).toBe(true);
    expect(mockQuery.mock.calls[0]![0]).toContain('WHERE NOT EXISTS');
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await sourceKeyRegistryRepository.createInitial(input)).toBe(false);
    await expect(sourceKeyRegistryRepository.createInitial({ ...input, key_version: 2 }))
      .rejects.toBeInstanceOf(SourceKeyRegistryConflictError);
  });

  it('rolls back only an exact initial record', async () => {
    mockQuery.mockResolvedValue({ rows: [{ user_id: input.user_id }], rowCount: 1 });
    expect(await sourceKeyRegistryRepository.deleteInitialIfMatch(input)).toBe(true);
    expect(mockQuery.mock.calls[0]![0]).toContain('recovery_wrapper = $6::JSONB');
    expect(mockQuery.mock.calls[0]![0]).toContain('retired_at IS NULL');
  });

  it('persists a retryable device-wrapper deletion intent', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await sourceKeyRegistryRepository.requestDeletion(input.user_id);
    expect(mockQuery.mock.calls[0]![0]).toContain('UPSERT INTO source_key_deletion_intents');
    expect(mockQuery.mock.calls[0]![1]).toEqual([input.user_id]);
  });

  it('revalidates the exact immutable live session authority tuple', async () => {
    const authority = {
      sessionId: '11111111-1111-4111-8111-111111111111',
      ownerId: '22222222-2222-4222-8222-222222222222',
      tokenHash: 'a'.repeat(64),
      expiresAtMs: 1_800_000_000_000,
    };
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: authority.sessionId }], rowCount: 1,
    });
    await expect(
      sourceKeyRegistryRepository.revalidateSessionAuthority(authority),
    ).resolves.toBe(true);
    expect(mockQuery.mock.calls[0]![0]).toContain('token_hash = $3');
    expect(mockQuery.mock.calls[0]![0]).toContain('revoked = false');
    expect(mockQuery.mock.calls[0]![0]).toContain('expires_at = $4');
    expect(mockQuery.mock.calls[0]![0]).toContain('expires_at > now()');
    expect(mockQuery.mock.calls[0]![1]).toEqual([
      authority.sessionId,
      authority.ownerId,
      authority.tokenHash,
      new Date(authority.expiresAtMs),
    ]);

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: authority.sessionId }, { id: authority.sessionId }], rowCount: 2,
    });
    await expect(
      sourceKeyRegistryRepository.revalidateSessionAuthority(authority),
    ).resolves.toBe(false);
  });

  it('rejects malformed session authority without querying CockroachDB', async () => {
    await expect(sourceKeyRegistryRepository.revalidateSessionAuthority({
      sessionId: 'not-a-uuid',
      ownerId: input.user_id,
      tokenHash: 'a'.repeat(64),
      expiresAtMs: 1_800_000_000_000,
    })).resolves.toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
