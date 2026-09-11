import { beforeEach, describe, expect, it, vi } from 'vitest';

const { withTransactionMock } = vi.hoisted(() => ({ withTransactionMock: vi.fn() }));

vi.mock('../connection.js', () => ({ withTransaction: withTransactionMock }));

const { gmailArchiveApprovalResponseRepository } = await import(
  '../repositories/gmail-archive-approval-response-repository.js'
);

const approvalId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

describe('gmailArchiveApprovalResponseRepository input boundary', () => {
  beforeEach(() => withTransactionMock.mockReset());

  it.each([
    null,
    {},
    { approvalId: 'invalid', userId, action: 'approve' },
    { approvalId, userId: 'invalid', action: 'approve' },
    { approvalId, userId, action: 'execute' },
    { approvalId, userId, action: 'approve', extra: true },
    { approvalId, userId, action: 'approve', reason: 'x'.repeat(2_001) },
  ])('rejects malformed input without opening a transaction: %o', async (input) => {
    await expect(gmailArchiveApprovalResponseRepository.respond(
      input as { approvalId: string; userId: string; action: 'approve' },
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects symbol keys, accessors, and throwing proxies without evaluating them', async () => {
    const symbolInput = { approvalId, userId, action: 'approve' as const };
    Object.defineProperty(symbolInput, Symbol('authority'), { value: true, enumerable: true });
    let getterRuns = 0;
    const accessorInput = { approvalId, userId } as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'action', {
      enumerable: true,
      get() {
        getterRuns += 1;
        return 'approve';
      },
    });
    const revoked = Proxy.revocable({ approvalId, userId, action: 'approve' as const }, {});
    revoked.revoke();
    const throwing = new Proxy({ approvalId, userId, action: 'approve' as const }, {
      ownKeys() {
        throw new Error('must be contained');
      },
    });

    for (const input of [symbolInput, accessorInput, revoked.proxy, throwing]) {
      await expect(gmailArchiveApprovalResponseRepository.respond(
        input as { approvalId: string; userId: string; action: 'approve' },
      )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(getterRuns).toBe(0);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('retries only a CockroachDB serialization failure around the database transaction', async () => {
    withTransactionMock
      .mockRejectedValueOnce(Object.assign(new Error('restart transaction'), { code: '40001' }))
      .mockResolvedValueOnce({ ok: false, error: 'not_found' });
    await expect(gmailArchiveApprovalResponseRepository.respond({
      approvalId,
      userId,
      action: 'approve',
    })).resolves.toEqual({ ok: false, error: 'not_found' });
    expect(withTransactionMock).toHaveBeenCalledTimes(2);

    withTransactionMock.mockReset().mockRejectedValueOnce(
      Object.assign(new Error('connection failed'), { code: '08006' }),
    );
    await expect(gmailArchiveApprovalResponseRepository.respond({
      approvalId,
      userId,
      action: 'approve',
    })).rejects.toMatchObject({ code: '08006' });
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });
});
