import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  gmailArchiveDispatchGateTestHooks,
} from '../repositories/gmail-archive-dispatch-gate-repository.js';
import { snapshotGmailArchiveAttemptState } from '../repositories/gmail-archive-attempt-state.js';

const command = {
  userId: '11111111-1111-4111-8111-111111111111',
  admissionId: '22222222-2222-4222-8222-222222222222',
  messageRefId: '33333333-3333-4333-8333-333333333333',
  operation: 'archive' as const,
};
const target = {
  connectorAccountId: '44444444-4444-4444-8444-444444444444',
  credentialRevision: '55555555-5555-4555-8555-555555555555',
  providerMessageId: 'provider-message',
};

describe('gmailArchiveDispatchGateRepository boundary', () => {
  it.each([
    null,
    {},
    { ...command, extra: true },
    { ...command, userId: 'invalid' },
    { ...command, admissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() },
    { ...command, messageRefId: 'invalid' },
    { ...command, operation: 'restore' },
  ])('contains malformed command input without a transaction: %o', async (input) => {
    let transactionCalls = 0;
    const transaction = async <T>(
      _callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      transactionCalls += 1;
      throw new Error('transaction must not run');
    };
    await expect(gmailArchiveDispatchGateTestHooks.enterWithTransition(
      input as never,
      target,
      vi.fn(),
      transaction,
    )).resolves.toEqual({
      status: 'conflict',
    });
    expect(transactionCalls).toBe(0);
  });

  it('rejects symbols, accessors, and hostile proxies without reading authority getters', async () => {
    let transactionCalls = 0;
    const transaction = async <T>(
      _callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      transactionCalls += 1;
      throw new Error('transaction must not run');
    };
    const symbol = { ...command };
    Object.defineProperty(symbol, Symbol('extra'), { enumerable: true, value: true });
    const getter = vi.fn(() => command.userId);
    const accessor = { ...command };
    Object.defineProperty(accessor, 'userId', { enumerable: true, get: getter });
    const revoked = Proxy.revocable({ ...command }, {});
    revoked.revoke();
    const throwing = new Proxy({ ...command }, { ownKeys: () => { throw new Error('contained'); } });
    const nullPrototype = Object.create(
      null,
      Object.fromEntries(Object.entries(command).map(([key, value]) => [
        key,
        { value, enumerable: true },
      ])),
    );

    for (const input of [symbol, accessor, revoked.proxy, throwing, nullPrototype]) {
      await expect(gmailArchiveDispatchGateTestHooks.enterWithTransition(
        input as never,
        target,
        vi.fn(),
        transaction,
      )).resolves.toEqual({ status: 'conflict' });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(transactionCalls).toBe(0);
  });

  it('snapshots the command and retries the whole transaction twice on 40001', async () => {
    let transactionCalls = 0;
    const transaction = async <T>(
      callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      transactionCalls += 1;
      return callback({} as PoolClient);
    };
    const submitted = { ...command };
    const seen: unknown[] = [];
    let attempts = 0;
    const pending = gmailArchiveDispatchGateTestHooks.enterWithTransition(
      submitted,
      target,
      async (_client, snapshot, targetSnapshot) => {
        seen.push({ snapshot, targetSnapshot });
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('restart'), { code: '40001' });
        return { status: 'entered' };
      },
      transaction,
    );
    submitted.messageRefId = '44444444-4444-4444-8444-444444444444';

    await expect(pending).resolves.toEqual({ status: 'entered' });
    expect(transactionCalls).toBe(3);
    expect(seen).toHaveLength(3);
    expect(seen).toEqual(Array(3).fill({ snapshot: command, targetSnapshot: target }));
    const first = seen[0] as { snapshot: typeof command; targetSnapshot: typeof target };
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.targetSnapshot)).toBe(true);
  });

  it.each([
    null,
    {},
    { ...target, extra: true },
    { ...target, connectorAccountId: 'invalid' },
    { ...target, credentialRevision: 'invalid' },
    { ...target, providerMessageId: '' },
    { ...target, providerMessageId: 'malformed-\ud800-surrogate' },
  ])('contains malformed target input without a transaction: %o', async (input) => {
    const transaction = vi.fn(async <T>(_callback: (client: PoolClient) => Promise<T>) => {
      throw new Error('transaction must not run');
    });

    await expect(gmailArchiveDispatchGateTestHooks.enterWithTransition(
      command,
      input as never,
      vi.fn(),
      transaction,
    )).resolves.toEqual({ status: 'conflict' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not retry an ambiguous commit failure', async () => {
    const ambiguous = Object.assign(new Error('commit response lost'), { code: '08006' });
    let transactionCalls = 0;
    const transaction = async <T>(
      _callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      transactionCalls += 1;
      throw ambiguous;
    };

    await expect(gmailArchiveDispatchGateTestHooks.enterWithTransition(
      command,
      target,
      vi.fn(),
      transaction,
    )).rejects.toBe(ambiguous);
    expect(transactionCalls).toBe(1);
  });

  it('strictly parses only the two exact versioned attempt states', () => {
    expect(snapshotGmailArchiveAttemptState({
      schema: 'gmail_archive_attempt_v1', phase: 'pre_dispatch',
    })).toEqual({ schema: 'gmail_archive_attempt_v1', phase: 'pre_dispatch' });
    expect(snapshotGmailArchiveAttemptState({
      schema: 'gmail_archive_attempt_v1', phase: 'dispatch_may_have_started',
    })).toEqual({ schema: 'gmail_archive_attempt_v1', phase: 'dispatch_may_have_started' });
    for (const value of [
      {},
      { schema: 'gmail_archive_attempt_v1', phase: 'pre_dispatch', extra: true },
      { schema: 'gmail_archive_attempt_v2', phase: 'pre_dispatch' },
      { schema: 'gmail_archive_attempt_v1', phase: 'dispatched' },
    ]) expect(snapshotGmailArchiveAttemptState(value)).toBeNull();
  });
});
