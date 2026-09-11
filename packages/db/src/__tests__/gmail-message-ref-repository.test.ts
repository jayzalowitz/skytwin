import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: vi.fn(),
  withTransaction: async (fn: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
    fn({ query: clientQuery }),
}));

const { gmailMessageRefRepository } = await import('../repositories/gmail-message-ref-repository.js');

const input = {
  userId: '11111111-1111-4111-8111-111111111111',
  connectorAccountId: '22222222-2222-4222-8222-222222222222',
  sourceSignalId: 'sig-account-message',
  providerMessageId: 'provider-message',
  providerThreadId: 'provider-thread',
  authoringTier: 'inbox_personal',
  observedInInbox: true,
  observedAt: new Date('2026-09-11T12:00:00.000Z'),
  signalTimestamp: new Date('2026-09-11T11:00:00.000Z'),
  signalType: 'work_email',
  signalData: { subject: 'Hello', authoringTier: 'inbox_personal' },
};

function messageRef(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: input.userId,
    connector_account_id: input.connectorAccountId,
    provider: 'google',
    provider_message_id: input.providerMessageId,
    provider_thread_id: input.providerThreadId,
    source_signal_id: input.sourceSignalId,
    authoring_tier: input.authoringTier,
    last_observed_inbox: true,
    first_observed_at: input.observedAt,
    last_observed_at: input.observedAt,
    created_at: input.observedAt,
    updated_at: input.observedAt,
    ...overrides,
  };
}

function signal(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    user_id: input.userId,
    source: 'gmail',
    type: input.signalType,
    domain: 'email',
    data: input.signalData,
    timestamp: input.observedAt,
    retention_until: new Date('2026-10-11T12:00:00.000Z'),
    created_at: input.observedAt,
    source_signal_id: input.sourceSignalId,
    connector_account_id: input.connectorAccountId,
    resource_ref_id: messageRef().id,
    ...overrides,
  };
}

describe('gmailMessageRefRepository.persistEvidence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists the owned message reference before the Watch-visible signal', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [messageRef()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [signal()], rowCount: 1 });

    const result = await gmailMessageRefRepository.persistEvidence(input);

    expect(result).toMatchObject({ ok: true, created: true });
    expect(clientQuery.mock.calls[0]![0]).toContain('INSERT INTO gmail_message_refs');
    expect(clientQuery.mock.calls[0]![0]).toContain('ca.is_active = true');
    expect(clientQuery.mock.calls[0]![0]).toContain('ca.identity_verified = true');
    expect(clientQuery.mock.calls[1]![0]).toContain('INSERT INTO signals');
    expect(clientQuery.mock.calls[1]![0]).toContain("SELECT $1, 'gmail'");
  });

  it('returns the original immutable signal on an exact duplicate', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [messageRef()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [signal()], rowCount: 1 });

    const result = await gmailMessageRefRepository.persistEvidence({
      ...input,
      signalData: { subject: 'attacker changed replay payload' },
    });

    expect(result).toMatchObject({ ok: true, created: false });
    if (result.ok) expect(result.signal.data).toEqual(input.signalData);
  });

  it('cannot rebind an existing provider message to another source signal id', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [messageRef()], rowCount: 1 });
    const result = await gmailMessageRefRepository.persistEvidence({
      ...input,
      sourceSignalId: 'sig-forged-rebind',
    });
    expect(result).toEqual({ ok: false, error: 'source_binding_conflict' });
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it('maps a reverse source uniqueness race to a deterministic conflict', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    clientQuery.mockRejectedValueOnce(uniqueViolation);
    const result = await gmailMessageRefRepository.persistEvidence(input);
    expect(result).toEqual({ ok: false, error: 'source_binding_conflict' });
  });

  it('cannot upgrade immutable provenance on an adversarial replay', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [messageRef()], rowCount: 1 });
    const result = await gmailMessageRefRepository.persistEvidence({
      ...input,
      authoringTier: 'user_sent_originated',
    });
    expect(result).toEqual({ ok: false, error: 'immutable_binding_conflict' });
    expect(clientQuery.mock.calls[0]![0]).not.toContain('authoring_tier = EXCLUDED.authoring_tier');
  });

  it('does not let stale or equal-time replay overwrite the latest Inbox observation', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [messageRef({ last_observed_inbox: true })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [signal()], rowCount: 1 });

    const result = await gmailMessageRefRepository.persistEvidence({
      ...input,
      observedInInbox: false,
      observedAt: new Date('2026-09-10T12:00:00.000Z'),
    });

    expect(result).toMatchObject({ ok: true, messageRef: { last_observed_inbox: true } });
    const upsertSql = clientQuery.mock.calls[0]![0] as string;
    expect(upsertSql).toContain('EXCLUDED.last_observed_at > gmail_message_refs.last_observed_at');
    expect(upsertSql).not.toContain('>=' );
  });

  it('rejects an inactive, foreign, or nonexistent account before storing a signal', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await gmailMessageRefRepository.persistEvidence(input);
    expect(result).toEqual({ ok: false, error: 'account_not_active' });
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });
});
