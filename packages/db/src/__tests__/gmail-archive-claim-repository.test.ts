import { beforeEach, describe, expect, it, vi } from 'vitest';

const { withTransactionMock } = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({ withTransaction: withTransactionMock }));

const { gmailArchiveClaimRepository, gmailArchiveClaimTestHooks } = await import(
  '../repositories/gmail-archive-claim-repository.js'
);

const approvalId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

describe('gmailArchiveClaimRepository input and retry boundary', () => {
  beforeEach(() => {
    withTransactionMock.mockReset();
  });

  it.each([
    null,
    {},
    { approvalId: 'invalid', userId },
    { approvalId, userId: 'invalid' },
    { approvalId, userId, extra: true },
    Object.create(null, { approvalId: { value: approvalId, enumerable: true }, userId: { value: userId, enumerable: true } }),
  ])('rejects malformed input without opening a transaction: %o', async (input) => {
    await expect(gmailArchiveClaimRepository.claim(
      input as { approvalId: string; userId: string },
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects symbols, accessors, and hostile proxies without reading authority values', async () => {
    const symbolInput = { approvalId, userId };
    Object.defineProperty(symbolInput, Symbol('extra'), { value: true, enumerable: true });
    let getterRuns = 0;
    const accessorInput = { userId } as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'approvalId', {
      enumerable: true,
      get() {
        getterRuns += 1;
        return approvalId;
      },
    });
    const revoked = Proxy.revocable({ approvalId, userId }, {});
    revoked.revoke();
    const throwing = new Proxy({ approvalId, userId }, {
      ownKeys() {
        throw new Error('contained');
      },
    });
    for (const input of [symbolInput, accessorInput, revoked.proxy, throwing]) {
      await expect(gmailArchiveClaimRepository.claim(
        input as { approvalId: string; userId: string },
      )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(getterRuns).toBe(0);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('snapshots authority before the transaction and never exposes caller mutation', async () => {
    const input = { approvalId, userId };
    let observed: Readonly<typeof input> | undefined;
    withTransactionMock.mockImplementation(async (callback) => callback({}));
    const result = gmailArchiveClaimTestHooks.claimWithTransition(input, async (_client, snapshot) => {
      observed = snapshot;
      input.approvalId = '33333333-3333-4333-8333-333333333333';
      return { ok: true, claimed: false, state: 'not_ready', command: null };
    });
    await expect(result).resolves.toEqual({ ok: true, claimed: false, state: 'not_ready', command: null });
    expect(observed).toEqual({ approvalId, userId });
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it('bounds whole-transaction serialization retries and does not retry commit ambiguity', async () => {
    withTransactionMock.mockImplementation(async (callback) => callback({}));
    let attempt = 0;
    await expect(gmailArchiveClaimTestHooks.claimWithTransition(
      { approvalId, userId },
      async () => {
        attempt += 1;
        if (attempt < 3) throw Object.assign(new Error('restart'), { code: '40001' });
        return { ok: true, claimed: false, state: 'in_progress', command: null };
      },
    )).resolves.toEqual({ ok: true, claimed: false, state: 'in_progress', command: null });
    expect(withTransactionMock).toHaveBeenCalledTimes(3);

    withTransactionMock.mockReset().mockRejectedValue(Object.assign(new Error('commit response lost'), { code: '08006' }));
    await expect(gmailArchiveClaimTestHooks.claimWithTransition(
      { approvalId, userId },
      async () => ({
        ok: true,
        claimed: true,
        command: Object.freeze({ userId, admissionId: approvalId, messageRefId: approvalId, operation: 'archive' }),
      }),
    )).rejects.toMatchObject({ code: '08006' });
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('throws through the transaction boundary when the second CAS loses', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: approvalId, status: 'in_progress' }] })
      .mockResolvedValueOnce({ rows: [] });
    withTransactionMock.mockImplementation(async (callback) => callback({ query: queryMock }));
    await expect(gmailArchiveClaimTestHooks.claimWithTransition(
      { approvalId, userId },
      async (client, input) => {
        await gmailArchiveClaimTestHooks.claimPreparedPair(
          client,
          input,
          { decision: { id: approvalId }, candidate: { id: userId } } as never,
          { id: approvalId, explanation_id: userId } as never,
          { id: userId } as never,
          { parameters: { messageRefId: approvalId } } as never,
          {},
        );
        return { ok: true, claimed: false, state: 'in_progress', command: null };
      },
    )).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(String(queryMock.mock.calls[0]?.[0])).toContain("status = 'in_progress'");
    expect(String(queryMock.mock.calls[1]?.[0])).toContain("plan.status = 'pending'");
  });
});
