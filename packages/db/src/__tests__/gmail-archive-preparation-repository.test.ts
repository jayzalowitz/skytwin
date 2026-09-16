import { beforeEach, describe, expect, it, vi } from 'vitest';

const { randomUUIDMock, withTransactionMock } = vi.hoisted(() => ({
  randomUUIDMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({ withTransaction: withTransactionMock }));
vi.mock('node:crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomUUID: randomUUIDMock,
}));

const { gmailArchivePreparationRepository, gmailArchivePreparationTestHooks } = await import(
  '../repositories/gmail-archive-preparation-repository.js'
);

const approvalId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

describe('gmailArchivePreparationRepository input and retry boundary', () => {
  beforeEach(() => {
    withTransactionMock.mockReset();
    let counter = 0;
    randomUUIDMock.mockReset().mockImplementation(() => {
      counter += 1;
      return `99000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    });
  });

  it.each([
    null,
    {},
    { approvalId: 'invalid', userId },
    { approvalId, userId: 'invalid' },
    { approvalId, userId, extra: true },
  ])('rejects malformed input without opening a transaction: %o', async (input) => {
    await expect(gmailArchivePreparationRepository.prepare(
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
      await expect(gmailArchivePreparationRepository.prepare(
        input as { approvalId: string; userId: string },
      )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(getterRuns).toBe(0);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('bounds whole-transaction serialization retries and does not retry other failures', async () => {
    withTransactionMock.mockImplementation(async (callback) => callback({}));
    const observedIds: unknown[] = [];
    let attempt = 0;
    await expect(gmailArchivePreparationTestHooks.prepareWithTransition(
      { approvalId, userId },
      async (_client, _input, ids) => {
        observedIds.push({ ...ids });
        attempt += 1;
        if (attempt < 3) throw Object.assign(new Error('restart'), { code: '40001' });
        return { ok: false, error: 'not_found' };
      },
    ))
      .resolves.toEqual({ ok: false, error: 'not_found' });
    expect(withTransactionMock).toHaveBeenCalledTimes(3);
    expect(randomUUIDMock).toHaveBeenCalledTimes(4);
    expect(observedIds).toHaveLength(3);
    expect(observedIds[1]).toEqual(observedIds[0]);
    expect(observedIds[2]).toEqual(observedIds[0]);

    withTransactionMock.mockClear();
    await expect(gmailArchivePreparationTestHooks.prepareWithTransition(
      { approvalId, userId },
      async () => { throw Object.assign(new Error('connection'), { code: '08006' }); },
    ))
      .rejects.toMatchObject({ code: '08006' });
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });
});
