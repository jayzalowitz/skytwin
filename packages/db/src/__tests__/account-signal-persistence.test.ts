import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseQuery = vi.fn();

vi.mock('../connection.js', () => ({ query: databaseQuery }));

const { signalRepository } = await import('../repositories/signal-repository.js');

const accountInput = {
  userId: '11111111-1111-4111-8111-111111111111',
  connectorAccountId: '22222222-2222-4222-8222-222222222222',
  provider: 'microsoft' as const,
  source: 'outlook' as const,
  signalType: 'work_email',
  domain: 'email' as const,
  signalData: { subject: 'Status', authoringTier: 'inbox_personal' },
  timestamp: new Date('2026-09-16T05:00:00.000Z'),
  sourceSignalId: 'sig-account-message',
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: accountInput.userId,
    source: accountInput.source,
    type: accountInput.signalType,
    domain: accountInput.domain,
    data: accountInput.signalData,
    timestamp: accountInput.timestamp,
    retention_until: new Date('2026-10-16T05:00:00.000Z'),
    created_at: accountInput.timestamp,
    source_signal_id: accountInput.sourceSignalId,
    connector_account_id: accountInput.connectorAccountId,
    resource_ref_id: null,
    ...overrides,
  };
}

describe('signalRepository account persistence', () => {
  beforeEach(() => databaseQuery.mockReset());

  it('admits account signals only through an active verified owner join', async () => {
    databaseQuery.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });

    await expect(signalRepository.persistAccountConnectorSignal(accountInput))
      .resolves.toMatchObject({ created: true });

    const [sql, args] = databaseQuery.mock.calls[0]!;
    expect(sql).toContain('FROM connected_accounts AS account');
    expect(sql).toContain('account.user_id = $1');
    expect(sql).toContain('account.is_active = true');
    expect(sql).toContain('account.identity_verified = true');
    expect(args).toContain(accountInput.connectorAccountId);
  });

  it('returns immutable first-observation data on a replay', async () => {
    databaseQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row()], rowCount: 1 });

    const result = await signalRepository.persistAccountConnectorSignal({
      ...accountInput,
      signalData: { subject: 'changed replay' },
    });

    expect(result).toMatchObject({ created: false });
    expect(result?.signal.data).toEqual(accountInput.signalData);
    expect(databaseQuery.mock.calls[1]![0]).toContain('account.is_active = true');
  });

  it('fails closed when the account is unavailable', async () => {
    databaseQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(signalRepository.persistAccountConnectorSignal(accountInput)).resolves.toBeNull();
  });
});
