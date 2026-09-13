import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../connection.js', () => ({
  withTransaction: (fn: (client: { query: typeof mockQuery }) => Promise<unknown>) =>
    fn({ query: mockQuery }),
}));

const { credentialDispatchLeaseRepository } = await import(
  '../repositories/credential-dispatch-lease-repository.js'
);

const NOW = new Date('2026-09-13T10:00:00.000Z');
const TOKEN = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  user_id: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
  account_email: 'a@example.com',
  account_provider_id: 'provider-account',
  access_token: 'never-persist-this-access-token',
  refresh_token: 'never-persist-this-refresh-token',
  expires_at: new Date('2026-09-13T11:00:00.000Z'),
  scopes: [],
  credential_revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  dispatch_generation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  dispatch_state: 'active',
  created_at: NOW,
  updated_at: NOW,
};
const INPUT = {
  userId: TOKEN.user_id,
  provider: 'google',
  decisionId: '22222222-2222-4222-8222-222222222222',
  actionId: '33333333-3333-4333-8333-333333333333',
  executionPlanId: '44444444-4444-4444-8444-444444444444',
  expectedOAuthTokenId: TOKEN.id,
  expectedCredentialRevision: TOKEN.credential_revision,
  expectedAuthorityRevision: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  expectedPolicyAuthorityRevision: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  now: NOW,
};

describe('credentialDispatchLeaseRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists exact graph and credential revisions without storing either OAuth secret', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: INPUT.userId, autonomy_settings: {}, execution_authority_revision: INPUT.expectedAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [{ revision: INPUT.expectedPolicyAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ authority_kind: 'admission', authority_id: '55555555-5555-4555-8555-555555555555' }] })
      .mockResolvedValueOnce({ rows: [TOKEN] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'lease-row' }] });

    const result = await credentialDispatchLeaseRepository.start(INPUT);
    expect(result).toMatchObject({
      success: true,
      grant: { oauthTokenId: TOKEN.id },
    });
    if (!result.success) return;
    expect(result.grant.capability).toHaveLength(43);
    const insert = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO credential_dispatch_leases'))!;
    const expiryTransition = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET state = 'ambiguous'"))!;
    expect(String(expiryTransition[0])).not.toContain("state = 'expired'");
    const persisted = JSON.stringify(insert[1]);
    expect(persisted).toContain(TOKEN.credential_revision);
    expect(persisted).toContain(TOKEN.dispatch_generation);
    expect(persisted).not.toContain(TOKEN.access_token);
    expect(persisted).not.toContain(TOKEN.refresh_token);
    expect(persisted).not.toContain(result.grant.capability);
  });

  it('does not read a credential after exact admission authority is revoked', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: INPUT.userId, autonomy_settings: {}, execution_authority_revision: INPUT.expectedAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [{ revision: INPUT.expectedPolicyAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(credentialDispatchLeaseRepository.start(INPUT)).resolves.toMatchObject({
      success: false,
      code: 'authority_revoked',
    });
    expect(mockQuery.mock.calls.some(([sql]) =>
      String(sql).includes('SELECT * FROM oauth_tokens'))).toBe(false);
  });

  it('rejects a policy or trust revision changed after routing before reading a credential', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: INPUT.userId,
        autonomy_settings: {},
        execution_authority_revision: 'newer-authority-revision',
      }],
    });

    await expect(credentialDispatchLeaseRepository.start(INPUT)).resolves.toMatchObject({
      success: false,
      code: 'authority_revoked',
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects plan replay even after a prior lease terminalized', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: INPUT.userId, autonomy_settings: {}, execution_authority_revision: INPUT.expectedAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [{ revision: INPUT.expectedPolicyAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ authority_kind: 'receipt', authority_id: INPUT.decisionId }] })
      .mockResolvedValueOnce({ rows: [TOKEN] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'prior-lease' }] });
    await expect(credentialDispatchLeaseRepository.start(INPUT)).resolves.toMatchObject({
      success: false,
      code: 'dispatch_replayed',
    });
    expect(mockQuery.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO credential_dispatch_leases'))).toBe(false);
  });

  it('binds terminalization to both the random capability hash and generation', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: INPUT.userId }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(credentialDispatchLeaseRepository.terminalize({
      userId: INPUT.userId,
      executionPlanId: INPUT.executionPlanId,
      capability: 'wrong-capability',
      leaseGeneration: 'wrong-generation',
      state: 'completed',
      now: NOW,
    })).resolves.toBe(false);
    const update = mockQuery.mock.calls[1]!;
    expect(String(update[0])).toContain('capability_hash = $3');
    expect(String(update[0])).toContain("state IN ('request_started', 'ambiguous')");
    expect(JSON.stringify(update[1])).not.toContain('wrong-capability');
  });
});
