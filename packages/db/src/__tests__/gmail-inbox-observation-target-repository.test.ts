import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recoveryQuery = vi.fn();

vi.mock('../connection.js', () => ({ withTransaction: vi.fn() }));
vi.mock('../repositories/gmail-archive-recovery-repository.js', () => ({
  queryAbandonedGmailArchiveInTransaction: recoveryQuery,
}));

const { gmailInboxObservationTargetTestHooks } = await import(
  '../repositories/gmail-inbox-observation-target-repository.js'
);

const command = {
  userId: '11111111-1111-4111-8111-111111111111',
  admissionId: '22222222-22a2-4222-8222-222222222222',
  messageRefId: '33333333-3333-4333-8333-333333333333',
  operation: 'observe_inbox' as const,
};
const mutationCommand = {
  userId: command.userId,
  admissionId: command.admissionId,
  messageRefId: command.messageRefId,
  operation: 'archive' as const,
};
const approvalId = '55555555-5555-4555-8555-555555555555';
const targetRow = {
  connector_account_id: '44444444-4444-4444-8444-444444444444',
  credential_revision: '77777777-7777-4777-8777-777777777777',
  provider_message_id: 'native-id',
};

function client(queries: Array<{ rows: unknown[] }> = [
  { rows: [{ idempotency_key: approvalId }] },
  { rows: [targetRow] },
]) {
  let index = 0;
  return {
    query: vi.fn(async () => queries[index++] ?? { rows: [] }),
  } as unknown as PoolClient;
}

function eligible(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 'eligible',
    recovery: {
      command: mutationCommand,
      phase: 'dispatch_may_have_started',
      phaseChangedAt: '2026-09-12T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('gmailInboxObservationTargetRepository boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recoveryQuery.mockResolvedValue(eligible());
  });

  it.each([
    null,
    {},
    { ...command, extra: true },
    { ...command, operation: 'archive' },
    { ...command, userId: 'invalid' },
    { ...command, admissionId: command.admissionId.toUpperCase() },
  ])('rejects a malformed command before opening a transaction: %o', async (submitted) => {
    const transaction = vi.fn();
    await expect(gmailInboxObservationTargetTestHooks.resolveWithTransaction(
      submitted as never,
      transaction,
    )).resolves.toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(recoveryQuery).not.toHaveBeenCalled();
  });

  it('contains accessors and hostile proxies without reading authority', async () => {
    const getter = vi.fn(() => command.userId);
    const accessor = { ...command } as Record<string, unknown>;
    Object.defineProperty(accessor, 'userId', { enumerable: true, get: getter });
    const revoked = Proxy.revocable({ ...command }, {});
    revoked.revoke();
    const transaction = vi.fn();

    for (const submitted of [accessor, revoked.proxy]) {
      await expect(gmailInboxObservationTargetTestHooks.resolveWithTransaction(
        submitted as never,
        transaction,
      )).resolves.toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reuses one frozen command snapshot across bounded serialization retries', async () => {
    let attempts = 0;
    const seenBarrierParams: unknown[][] = [];
    const transaction = async <T>(callback: (poolClient: PoolClient) => Promise<T>): Promise<T> => {
      attempts += 1;
      const queryClient = client();
      const queryMock = queryClient.query as ReturnType<typeof vi.fn>;
      const result = await callback(queryClient);
      seenBarrierParams.push(queryMock.mock.calls[0]?.[1] as unknown[]);
      return result;
    };
    recoveryQuery
      .mockRejectedValueOnce(Object.assign(new Error('restart'), { code: '40001' }))
      .mockRejectedValueOnce(Object.assign(new Error('restart'), { code: '40001' }))
      .mockResolvedValueOnce(eligible());
    const submitted = { ...command, operation: 'observe_inbox' as 'observe_inbox' | 'archive' };

    const pending = gmailInboxObservationTargetTestHooks.resolveWithTransaction(
      submitted as typeof command,
      transaction,
    );
    submitted.operation = 'archive';
    submitted.userId = '99999999-9999-4999-8999-999999999999';
    await expect(pending).resolves.toEqual({
      connectorAccountId: targetRow.connector_account_id,
      credentialRevision: targetRow.credential_revision,
      providerMessageId: targetRow.provider_message_id,
    });
    expect(attempts).toBe(3);
    expect(recoveryQuery).toHaveBeenCalledTimes(3);
    for (const call of recoveryQuery.mock.calls) {
      expect(call[1]).toEqual({ userId: command.userId, approvalId });
    }
  });

  it('does not retry non-serialization or ambiguous commit failures', async () => {
    for (const code of ['08006', 'XX000']) {
      const error = Object.assign(new Error('transaction failed'), { code });
      const transaction = vi.fn().mockRejectedValue(error);
      await expect(gmailInboxObservationTargetTestHooks.resolveWithTransaction(
        command,
        transaction,
      )).rejects.toBe(error);
      expect(transaction).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['not due', { ok: true, status: 'not_due', recovery: null }],
    ['terminal', { ok: true, status: 'terminal', recovery: null }],
    ['legacy', { ok: false, error: 'legacy_untracked' }],
    ['pre-dispatch', eligible({
      recovery: { command: mutationCommand, phase: 'pre_dispatch', phaseChangedAt: '2026-09-12T12:00:00.000Z' },
    })],
    ['swapped command', eligible({
      recovery: {
        command: { ...mutationCommand, messageRefId: '66666666-6666-4666-8666-666666666666' },
        phase: 'dispatch_may_have_started',
        phaseChangedAt: '2026-09-12T12:00:00.000Z',
      },
    })],
  ])('requires an eligible exact dispatch-uncertain recovery: %s', async (_name, recovery) => {
    recoveryQuery.mockResolvedValueOnce(recovery);
    const queryClient = client();
    await expect(gmailInboxObservationTargetTestHooks.resolveInTransaction(
      queryClient,
      command,
    )).resolves.toBeNull();
    expect(queryClient.query).toHaveBeenCalledTimes(1);
  });

  it('returns one frozen live target only after durable recovery validation', async () => {
    const queryClient = client();
    const result = await gmailInboxObservationTargetTestHooks.resolveInTransaction(
      queryClient,
      command,
    );
    expect(result).toEqual({
      connectorAccountId: targetRow.connector_account_id,
      credentialRevision: targetRow.credential_revision,
      providerMessageId: targetRow.provider_message_id,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(recoveryQuery).toHaveBeenCalledWith(queryClient, {
      userId: command.userId,
      approvalId,
    });
    expect(queryClient.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    [[], null],
    [[targetRow, targetRow], null],
    [[{ ...targetRow, connector_account_id: 'invalid' }], null],
    [[{ ...targetRow, credential_revision: 'invalid' }], null],
    [[{ ...targetRow, provider_message_id: '' }], null],
  ])('rejects non-unique or malformed live target rows: %o', async (rows, expected) => {
    await expect(gmailInboxObservationTargetTestHooks.resolveInTransaction(
      client([{ rows: [{ idempotency_key: approvalId }] }, { rows }]),
      command,
    )).resolves.toBe(expected);
  });

  it('is SELECT-only and requires active verified owner, account/token scope, and exact binding joins', async () => {
    const source = await readFile(
      new URL('../repositories/gmail-inbox-observation-target-repository.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|UPSERT)\b/i);
    expect(source).toContain("barrier.status = 'in_progress'");
    expect(source).toContain("phase: 'dispatch_may_have_started'");
    expect(source).toContain('account.is_active = true');
    expect(source).toContain('account.identity_verified = true');
    expect(source).toContain('account.disconnected_at IS NULL');
    expect(source).toContain('$7::STRING = ANY(account.scopes)');
    expect(source).toContain('$7::STRING = ANY(token.scopes)');
    expect(source).toContain('LIMIT 2');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('@skytwin/policy-engine');
  });
});
