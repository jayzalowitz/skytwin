import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../connection.js', () => ({
  withTransaction: (fn: (client: { query: typeof mockQuery }) => Promise<unknown>) =>
    fn({ query: mockQuery }),
}));

const { executionDispatchLeaseRepository } = await import(
  '../repositories/credential-dispatch-lease-repository.js'
);

const NOW = new Date('2026-09-13T10:00:00.000Z');
const AUTHORITY_ID = '55555555-5555-4555-8555-555555555555';
const INPUT = {
  userId: '11111111-1111-4111-8111-111111111111',
  decisionId: '22222222-2222-4222-8222-222222222222',
  actionId: '33333333-3333-4333-8333-333333333333',
  executionPlanId: '44444444-4444-4444-8444-444444444444',
  adapterName: 'ironclaw',
  expectedRiskSnapshot: {
    actionId: '33333333-3333-4333-8333-333333333333',
    overallTier: 'low',
    assessedAt: new Date('2026-09-13T09:59:00.000Z'),
  },
  expectedAuthorityRevision: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  expectedPolicyAuthorityRevision: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  expectedAdmissionAuthorityId: AUTHORITY_ID,
  expectedAdmissionAuthorityUpdatedAt: NOW.toISOString(),
  now: NOW,
};
const AUTHORITY = {
  authority_kind: 'admission',
  authority_id: AUTHORITY_ID,
  authority_updated_at: NOW,
  adapter_name: INPUT.adapterName,
  risk_snapshot: {
    ...INPUT.expectedRiskSnapshot,
    assessedAt: INPUT.expectedRiskSnapshot.assessedAt.toISOString(),
  },
};
const TOKEN = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  user_id: INPUT.userId,
  provider: 'google',
  account_email: 'a@example.com',
  access_token: 'never-persist-this-access-token',
  refresh_token: 'never-persist-this-refresh-token',
  expires_at: new Date('2026-09-13T11:00:00.000Z'),
  credential_revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  dispatch_generation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  dispatch_state: 'active',
};

describe('executionDispatchLeaseRepository', () => {
  beforeEach(() => mockQuery.mockReset());

  it.each([
    ['sk-proj-', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
    ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
    ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
    ['ya29.', 'a0AfH6SMBabcdefghijklmnopqrstuvwxyz'].join(''),
  ])('refuses a credential-shaped durable adapter identity: %s', async (adapterName) => {
    await expect(executionDispatchLeaseRepository.start({
      ...INPUT,
      adapterName,
    })).resolves.toMatchObject({ success: false, code: 'authority_revoked' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('persists exact generic authority without storing the bearer capability', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        id: INPUT.userId, autonomy_settings: {},
        execution_authority_revision: INPUT.expectedAuthorityRevision,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: INPUT.expectedPolicyAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [AUTHORITY] })
      .mockResolvedValueOnce({ rows: [{ id: 'lease-row' }] });

    const result = await executionDispatchLeaseRepository.start(INPUT);
    expect(result).toMatchObject({ success: true });
    if (!result.success) return;
    expect(result.grant.capability).toHaveLength(43);
    const insert = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO credential_dispatch_leases'))!;
    const persisted = JSON.stringify(insert[1]);
    expect(persisted).toContain(INPUT.adapterName);
    expect(persisted).toContain(INPUT.expectedAuthorityRevision);
    expect(persisted).toContain(INPUT.expectedPolicyAuthorityRevision);
    expect(persisted).not.toContain(result.grant.capability);
    expect(String(insert[0])).toContain('risk_snapshot');
  });

  it('refuses a pause or revision change before creating request-start authority', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: INPUT.userId,
      autonomy_settings: { paused: true },
      execution_authority_revision: INPUT.expectedAuthorityRevision,
    }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(executionDispatchLeaseRepository.start(INPUT)).resolves.toMatchObject({
      success: false, code: 'authority_revoked',
    });
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('refuses when the exact admission authority changed during plan preparation', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        id: INPUT.userId, autonomy_settings: {},
        execution_authority_revision: INPUT.expectedAuthorityRevision,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: INPUT.expectedPolicyAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [{
        ...AUTHORITY,
        authority_updated_at: new Date('2026-09-13T10:00:01.000Z'),
      }] });
    await expect(executionDispatchLeaseRepository.start(INPUT)).resolves.toMatchObject({
      success: false, code: 'authority_revoked',
    });
    expect(mockQuery.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO credential_dispatch_leases'))).toBe(false);
  });

  it('binds exact MCP server/tool authorization before request start', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        id: INPUT.userId, autonomy_settings: {},
        execution_authority_revision: INPUT.expectedAuthorityRevision,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: INPUT.expectedPolicyAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...AUTHORITY, adapter_name: 'mcp-host' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'lease-row' }] });

    await expect(executionDispatchLeaseRepository.start({
      ...INPUT,
      adapterName: 'mcp-host',
      mcpServerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mcpToolName: 'send_email',
      expectedRiskSnapshot: INPUT.expectedRiskSnapshot,
    })).resolves.toMatchObject({ success: true });
    const insert = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO credential_dispatch_leases'))!;
    expect(insert[1]).toEqual(expect.arrayContaining([
      'mcp-host', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'send_email',
    ]));
  });

  it('refuses MCP request start when an exact tool opt-in is pending', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        id: INPUT.userId, autonomy_settings: {},
        execution_authority_revision: INPUT.expectedAuthorityRevision,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: INPUT.expectedPolicyAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] })
      .mockResolvedValueOnce({ rows: [{ pending: 1 }] });

    await expect(executionDispatchLeaseRepository.start({
      ...INPUT,
      adapterName: 'mcp-host',
      mcpServerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mcpToolName: 'send_email',
    })).resolves.toMatchObject({ success: false, code: 'authority_revoked' });
    expect(mockQuery.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO credential_dispatch_leases'))).toBe(false);
  });

  it('rejects replay even when the prior request-start row is terminal', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        id: INPUT.userId, autonomy_settings: {},
        execution_authority_revision: INPUT.expectedAuthorityRevision,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'prior-terminal-lease' }] });
    await expect(executionDispatchLeaseRepository.start(INPUT)).resolves.toMatchObject({
      success: false, code: 'dispatch_replayed',
    });
  });

  it('reports a prior request start as replay even after the owner is paused', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        id: INPUT.userId,
        autonomy_settings: { paused: true },
        execution_authority_revision: 'new-revision',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'request-already-started' }] });

    await expect(executionDispatchLeaseRepository.start(INPUT)).resolves.toMatchObject({
      success: false, code: 'dispatch_replayed',
    });
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('serializes unresolved requests for the same credential provider', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        id: INPUT.userId, autonomy_settings: {},
        execution_authority_revision: INPUT.expectedAuthorityRevision,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: INPUT.expectedPolicyAuthorityRevision }] })
      .mockResolvedValueOnce({ rows: [{ ...AUTHORITY, adapter_name: 'direct' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'other-google-resolution' }] });

    await expect(executionDispatchLeaseRepository.start({
      ...INPUT,
      adapterName: 'direct',
      credentialProvider: 'google',
      expectedOAuthTokenId: TOKEN.id,
      expectedCredentialRevision: TOKEN.credential_revision,
    })).resolves.toMatchObject({ success: false, code: 'authority_revoked' });
    const providerFence = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('provider = $2'))!;
    expect(String(providerFence[0])).not.toContain('oauth_token_id IS NULL');
    expect(mockQuery.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO credential_dispatch_leases'))).toBe(false);
  });

  it('binds an existing capability to an exact live OAuth revision without secrets', async () => {
    const capability = 'capability-kept-out-of-storage';
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: INPUT.userId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        execution_plan_id: INPUT.executionPlanId,
        oauth_token_id: null,
        provider: 'google',
        expires_at: new Date('2026-09-13T10:05:00.000Z'),
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [TOKEN] })
      .mockResolvedValueOnce({ rows: [{ id: 'lease-row' }] });
    const result = await executionDispatchLeaseRepository.bindCredential({
      ...INPUT,
      provider: 'google',
      capability,
      leaseGeneration: 'lease-generation',
      expectedOAuthTokenId: TOKEN.id,
      expectedCredentialRevision: TOKEN.credential_revision,
    });
    expect(result).toMatchObject({ success: true, grant: { oauthTokenId: TOKEN.id } });
    const update = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('SET oauth_token_id'))!;
    const persisted = JSON.stringify(update[1]);
    expect(persisted).toContain(TOKEN.credential_revision);
    expect(persisted).toContain(TOKEN.dispatch_generation);
    expect(persisted).not.toContain(TOKEN.access_token);
    expect(persisted).not.toContain(TOKEN.refresh_token);
    expect(persisted).not.toContain(capability);
  });

  it('does not let a provider-null generic capability bind an OAuth credential', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: INPUT.userId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        execution_plan_id: INPUT.executionPlanId,
        oauth_token_id: null,
        provider: null,
        expires_at: new Date('2026-09-13T10:05:00.000Z'),
      }] });

    await expect(executionDispatchLeaseRepository.bindCredential({
      ...INPUT,
      provider: 'google',
      capability: 'generic-capability',
      leaseGeneration: 'generic-generation',
      expectedOAuthTokenId: TOKEN.id,
      expectedCredentialRevision: TOKEN.credential_revision,
    })).resolves.toMatchObject({ success: false, code: 'credential_unavailable' });
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('binds terminalization to both the random capability hash and generation', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: INPUT.userId }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(executionDispatchLeaseRepository.terminalize({
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
