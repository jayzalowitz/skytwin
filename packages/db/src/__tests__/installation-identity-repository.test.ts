import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockClientQuery, mockWithTransaction } = vi.hoisted(() => {
  const mockQuery = vi.fn();
  const mockClientQuery = vi.fn();
  const mockWithTransaction = vi.fn(async (fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>) =>
    fn({ query: mockClientQuery }));
  return { mockQuery, mockClientQuery, mockWithTransaction };
});

vi.mock('../connection.js', () => ({
  query: mockQuery,
  withTransaction: mockWithTransaction,
}));

const { installationIdentityRepository } = await import(
  '../repositories/installation-identity-repository.js'
);

const CURRENT = {
  singleton: true as const,
  installation_id: '11111111-1111-4111-8111-111111111111',
  created_at: new Date('2026-09-10T00:00:00Z'),
};

describe('installationIdentityRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [CURRENT], rowCount: 1 });
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('returns the sole active installation identity', async () => {
    await expect(installationIdentityRepository.getCurrent()).resolves.toEqual(CURRENT);
    expect(mockQuery.mock.calls[0]![0]).toContain('WHERE singleton = true');
  });

  it('fails closed when the singleton identity is missing or duplicated', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(installationIdentityRepository.getCurrent()).rejects.toThrow(
      'installation_identity_unavailable',
    );
    mockQuery.mockResolvedValueOnce({ rows: [CURRENT, CURRENT], rowCount: 2 });
    await expect(installationIdentityRepository.getCurrent()).rejects.toThrow(
      'installation_identity_unavailable',
    );
  });

  it('uses a compare-and-swap delete and transactionally creates a replacement', async () => {
    const replacement = {
      ...CURRENT,
      installation_id: '22222222-2222-4222-8222-222222222222',
    };
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ installation_id: CURRENT.installation_id }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [replacement], rowCount: 1 });

    await expect(
      installationIdentityRepository.reset(CURRENT.installation_id),
    ).resolves.toEqual(replacement);
    expect(mockClientQuery.mock.calls[0]![0]).toContain(
      'singleton = true AND installation_id = $1',
    );
    expect(mockClientQuery.mock.calls[0]![1]).toEqual([CURRENT.installation_id]);
    expect(mockClientQuery.mock.calls[1]![0]).toContain(
      'INSERT INTO installation_identity',
    );
  });

  it('does not mint an identity for a stale reset request', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      installationIdentityRepository.reset(CURRENT.installation_id),
    ).resolves.toBeNull();
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
  });

  it('throws so withTransaction rolls back if replacement creation is incomplete', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ installation_id: CURRENT.installation_id }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      installationIdentityRepository.reset(CURRENT.installation_id),
    ).rejects.toThrow('installation_identity_reset_incomplete');
  });
});
