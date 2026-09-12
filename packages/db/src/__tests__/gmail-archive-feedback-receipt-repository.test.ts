import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { gmailArchiveFeedbackReceiptTestHooks } from
  '../repositories/gmail-archive-feedback-receipt-repository.js';

const userId = '11111111-1111-4111-8111-111111111111';
const approvalId = '22222222-2222-4222-8222-222222222222';
const feedbackEventId = '33333333-3333-4333-8333-333333333333';

describe('Gmail archive feedback receipt finalizer', () => {
  it.each([
    null,
    {},
    { userId, approvalId, feedbackEventId: 'bad' },
    { userId, approvalId: 'bad', feedbackEventId },
    { userId: 'bad', approvalId, feedbackEventId },
    { userId, approvalId, feedbackEventId, extra: true },
    Object.assign(Object.create({}), { userId, approvalId, feedbackEventId }),
  ])('rejects hostile input before opening a transaction: %o', async (input) => {
    const transaction = vi.fn();
    await expect(gmailArchiveFeedbackReceiptTestHooks.finalizeWithTransition(
      input as never,
      vi.fn(),
      transaction,
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reuses one revision ID across bounded serializable retries', async () => {
    const ids: string[] = [];
    const transition = vi.fn(async (_client, _input, stable) => {
      ids.push(stable.revisionId);
      if (ids.length < 3) throw Object.assign(new Error('retry'), { code: '40001' });
      return { ok: false as const, error: 'not_ready' as const };
    });
    const transaction = async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> =>
      callback({} as PoolClient);
    await expect(gmailArchiveFeedbackReceiptTestHooks.finalizeWithTransition(
      { userId, approvalId, feedbackEventId },
      transition,
      transaction,
    )).resolves.toEqual({ ok: false, error: 'not_ready' });
    expect(transition).toHaveBeenCalledTimes(3);
    expect(new Set(ids).size).toBe(1);
  });
});
