import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';

const clientQuery = vi.fn();
const databaseQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: databaseQuery,
  withTransaction: async (fn: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
    fn({ query: clientQuery }),
}));

const { gmailMessageRefRepository } = await import('../repositories/gmail-message-ref-repository.js');
const { decisionRepositoryAdapter } = await import('../adapters/decision-repository-adapter.js');

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
  beforeEach(() => {
    clientQuery.mockReset();
    databaseQuery.mockReset();
  });

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

const mutationInput = {
  userId: input.userId,
  admissionId: '55555555-5555-4555-8555-555555555555',
  messageRefId: messageRef().id,
  operation: 'archive' as const,
};
const credentialRevision = '88888888-8888-4888-8888-888888888888';

describe('gmailMessageRefRepository Inbox mutation binding', () => {
  beforeEach(() => {
    clientQuery.mockReset();
    databaseQuery.mockReset();
  });

  it('matches the exact six-key shape written by the production candidate serializer', async () => {
    const storedParameters = {
      schema: 'gmail_inbox_mutation_v1',
      messageRefId: mutationInput.messageRefId,
      operation: 'archive',
      domain: 'email',
      costZeroIntent: 'verified_zero',
      provenance: 'untrusted_external',
    };
    databaseQuery.mockResolvedValueOnce({
      rows: [{
        id: '66666666-6666-4666-8666-666666666666',
        decision_id: '77777777-7777-4777-8777-777777777777',
        action_type: 'archive_email',
        description: 'Archive one message.',
        parameters: storedParameters,
        predicted_user_preference: ConfidenceLevel.HIGH,
        risk_assessment: { reasoning: 'Bounded and reversible.' },
        reversible: true,
        estimated_cost: null,
        created_at: new Date(),
      }],
      rowCount: 1,
    });

    await decisionRepositoryAdapter.saveCandidates([{
      id: '66666666-6666-4666-8666-666666666666',
      decisionId: '77777777-7777-4777-8777-777777777777',
      actionType: 'archive_email',
      description: 'Archive one message.',
      domain: 'email',
      parameters: {
        schema: 'gmail_inbox_mutation_v1',
        messageRefId: mutationInput.messageRefId,
        operation: 'archive',
      },
      estimatedCostCents: 0,
      costZeroIntent: 'verified_zero',
      reversible: true,
      confidence: ConfidenceLevel.HIGH,
      reasoning: 'Bounded and reversible.',
      provenance: 'untrusted_external',
      capabilityProvenanceNodeId: undefined,
    }]);
    const persistedJson = (databaseQuery.mock.calls[0]?.[1] as unknown[])[4];
    expect(JSON.parse(String(persistedJson))).toEqual(storedParameters);

    clientQuery.mockResolvedValueOnce({
      rows: [{
        connector_account_id: input.connectorAccountId,
        credential_revision: credentialRevision,
        provider_message_id: input.providerMessageId,
      }],
      rowCount: 1,
    });
    await gmailMessageRefRepository.resolveInboxMutationTarget(mutationInput);
    const resolverJson = (clientQuery.mock.calls[0]?.[1] as unknown[])[3];
    expect(JSON.parse(String(resolverJson))).toEqual(storedParameters);
  });

  it('requires one exact event admission, canonical candidate, evidence chain, account, and scope', async () => {
    clientQuery.mockResolvedValueOnce({
      rows: [{
        connector_account_id: input.connectorAccountId,
        credential_revision: credentialRevision,
        provider_message_id: input.providerMessageId,
      }],
      rowCount: 1,
    });

    const result = await gmailMessageRefRepository.resolveInboxMutationTarget(mutationInput);

    expect(result).toEqual({
      connectorAccountId: input.connectorAccountId,
      credentialRevision,
      providerMessageId: input.providerMessageId,
    });
    const [sql, params] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("barrier.status = 'in_progress'");
    expect(sql).toContain("barrier.effect_type = 'event_execution'");
    expect(sql).toContain('barrier.failure_reason IS NULL');
    expect(sql).toContain('barrier.effect_result = $5::JSONB');
    expect(sql).toContain("candidate.action_type = 'archive_email'");
    expect(sql).toContain('candidate.parameters = $4::JSONB');
    expect(sql).toContain('candidate.reversible = true');
    expect(sql).toContain('candidate.estimated_cost IS NULL');
    expect(sql).toContain(
      'signal.id::STRING = decision.signal_id OR signal.source_signal_id = decision.signal_id',
    );
    expect(sql).toContain('ref.id = signal.resource_ref_id');
    expect(sql).toContain('ref.source_signal_id = signal.source_signal_id');
    expect(sql).toContain("decision.raw_event->>'messageRefId' = ref.id::STRING");
    expect(sql).toContain('account.identity_verified = true');
    expect(sql).toContain('account.disconnected_at IS NULL');
    expect(sql).toContain('$6::STRING = ANY(account.scopes)');
    expect(sql).toContain('$6::STRING = ANY(token.scopes)');
    expect(sql).toContain('token.credential_revision');
    expect(params).toEqual([
      mutationInput.admissionId,
      mutationInput.userId,
      mutationInput.messageRefId,
      JSON.stringify({
        schema: 'gmail_inbox_mutation_v1',
        messageRefId: mutationInput.messageRefId,
        operation: 'archive',
        domain: 'email',
        costZeroIntent: 'verified_zero',
        provenance: 'untrusted_external',
      }),
      JSON.stringify({ schema: 'gmail_archive_attempt_v1', phase: 'pre_dispatch' }),
      'https://www.googleapis.com/auth/gmail.modify',
    ]);
  });

  it('cannot let a same-user, same-source-id signal from another account choose the target', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(gmailMessageRefRepository.resolveInboxMutationTarget(mutationInput)).resolves.toBeNull();

    const sql = clientQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain("decision.raw_event->>'messageRefId' = ref.id::STRING");
    expect(sql).toContain('ref.connector_account_id = signal.connector_account_id');
    expect(sql).toContain('ref.id = $3');
  });

  it('rejects a corrupt signal-to-reference source binding', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(gmailMessageRefRepository.resolveInboxMutationTarget(mutationInput)).resolves.toBeNull();

    expect(clientQuery.mock.calls[0]?.[0]).toContain(
      'ref.source_signal_id = signal.source_signal_id',
    );
  });

  it('returns no target unless the binding resolves to exactly one row', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [
        {
          connector_account_id: input.connectorAccountId,
          credential_revision: credentialRevision,
          provider_message_id: 'one',
        },
        {
          connector_account_id: input.connectorAccountId,
          credential_revision: credentialRevision,
          provider_message_id: 'two',
        },
      ], rowCount: 2 });

    await expect(gmailMessageRefRepository.resolveInboxMutationTarget(mutationInput)).resolves.toBeNull();
    await expect(gmailMessageRefRepository.resolveInboxMutationTarget(mutationInput)).resolves.toBeNull();
  });

});
