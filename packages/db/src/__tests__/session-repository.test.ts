import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { sessionRepository } = await import('../repositories/session-repository.js');

describe('sessionRepository broker grant proof', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds an active grant proof to the exact session, owner, and token hash', async () => {
    const row = {
      id: 'session-1', user_id: 'user-1', token_hash: 'hash-1',
      expires_at: new Date(Date.now() + 60_000), revoked: false,
    };
    mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

    await expect(sessionRepository.findActiveForBrokerGrant('session-1', 'user-1', 'hash-1'))
      .resolves.toBe(row);
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('id = $1');
    expect(sql).toContain('user_id = $2');
    expect(sql).toContain('token_hash = $3');
    expect(sql).toContain('revoked = false');
    expect(sql).toContain('expires_at > now()');
    expect(args).toEqual(['session-1', 'user-1', 'hash-1']);
  });

  it('returns no grant proof after authoritative revocation or expiry', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(sessionRepository.findActiveForBrokerGrant('session-1', 'user-1', 'hash-1'))
      .resolves.toBeNull();
  });
});
