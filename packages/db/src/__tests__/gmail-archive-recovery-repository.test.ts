import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../connection.js', () => ({ withTransaction: vi.fn() }));
vi.mock('../repositories/gmail-archive-approval-response-repository.js', () => ({
  canonicalGmailArchiveCandidateMessageRef: vi.fn(),
}));
vi.mock('../repositories/gmail-archive-attempt-state.js', () => ({
  snapshotGmailArchiveAttemptState: vi.fn(),
}));
vi.mock('../repositories/gmail-archive-terminalization-repository.js', () => ({
  exactGmailArchiveApprovedPrefix: vi.fn(),
  exactGmailArchiveInProgressBaseline: vi.fn(),
  loadGmailArchivePolicyExplanation: vi.fn(),
  loadGmailArchiveStableState: vi.fn(),
  validateStoredGmailArchiveTerminal: vi.fn(),
}));

const {
  GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS,
  gmailArchiveRecoveryTestHooks,
} = await import('../repositories/gmail-archive-recovery-repository.js');

const input = {
  userId: '11111111-1111-4111-8111-111111111111',
  approvalId: '22222222-22a2-4222-8222-222222222222',
};

describe('gmailArchiveRecoveryRepository boundary', () => {
  it.each([
    null,
    {},
    { ...input, extra: true },
    { ...input, userId: 'invalid' },
    { ...input, approvalId: 'invalid' },
    { ...input, approvalId: input.approvalId.toUpperCase() },
  ])('rejects malformed authority before opening a transaction: %o', async (submitted) => {
    let transactionCalls = 0;
    const transaction = async <T>(
      _callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      transactionCalls += 1;
      throw new Error('transaction must not run');
    };
    await expect(gmailArchiveRecoveryTestHooks.queryWithTransition(
      submitted as never,
      vi.fn(),
      transaction,
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(transactionCalls).toBe(0);
  });

  it('contains symbols, accessors, and hostile proxies without reading authority', async () => {
    const symbol = { ...input };
    Object.defineProperty(symbol, Symbol('extra'), { enumerable: true, value: true });
    const getter = vi.fn(() => input.userId);
    const accessor = { approvalId: input.approvalId } as Record<string, unknown>;
    Object.defineProperty(accessor, 'userId', { enumerable: true, get: getter });
    const revoked = Proxy.revocable({ ...input }, {});
    revoked.revoke();
    const throwing = new Proxy({ ...input }, {
      ownKeys() {
        throw new Error('contained');
      },
    });
    const nullPrototype = Object.create(null, {
      userId: { enumerable: true, value: input.userId },
      approvalId: { enumerable: true, value: input.approvalId },
    });
    let transactionCalls = 0;
    const transaction = async <T>(
      _callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      transactionCalls += 1;
      throw new Error('transaction must not run');
    };

    for (const submitted of [symbol, accessor, revoked.proxy, throwing, nullPrototype]) {
      await expect(gmailArchiveRecoveryTestHooks.queryWithTransition(
        submitted,
        vi.fn(),
        transaction,
      )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(transactionCalls).toBe(0);
  });

  it('freezes one authority snapshot across bounded whole-transaction retries', async () => {
    let transactionCalls = 0;
    const transaction = async <T>(
      callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      transactionCalls += 1;
      return callback({} as PoolClient);
    };
    const submitted = { ...input };
    const seen: Readonly<typeof input>[] = [];
    const transition = vi.fn(async (_client, snapshot: Readonly<typeof input>) => {
      seen.push(snapshot);
      if (seen.length < 3) throw Object.assign(new Error('restart'), { code: '40001' });
      return { ok: true as const, status: 'not_due' as const, recovery: null };
    });
    const pending = gmailArchiveRecoveryTestHooks.queryWithTransition(
      submitted,
      transition,
      transaction,
    );
    submitted.approvalId = '33333333-3333-4333-8333-333333333333';

    await expect(pending).resolves.toEqual({ ok: true, status: 'not_due', recovery: null });
    expect(transactionCalls).toBe(3);
    expect(seen).toHaveLength(3);
    expect(seen.every((value) => value === seen[0])).toBe(true);
    expect(seen[0]).toEqual(input);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it('does not retry a non-serialization or ambiguous commit failure', async () => {
    for (const code of ['08006', 'XX000']) {
      const error = Object.assign(new Error('transaction failed'), { code });
      let transactionCalls = 0;
      const transaction = async <T>(
        _callback: (client: PoolClient) => Promise<T>,
      ): Promise<T> => {
        transactionCalls += 1;
        throw error;
      };
      await expect(gmailArchiveRecoveryTestHooks.queryWithTransition(
        input,
        vi.fn(),
        transaction,
      )).rejects.toBe(error);
      expect(transactionCalls).toBe(1);
    }
  });

  it('is a fixed DB-clock read with no write or policy/provider dependency', async () => {
    const source = await readFile(
      new URL('../repositories/gmail-archive-recovery-repository.ts', import.meta.url),
      'utf8',
    );
    expect(GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS).toBe(300);
    expect(source).toContain("$2::INT * INTERVAL '1 second'");
    expect(source).toContain('GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS]');
    expect(source).toContain('barrier.updated_at.toISOString()');
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|UPSERT)\b/i);
    expect(source).not.toContain('@skytwin/policy-engine');
    expect(source).not.toContain('loadCanonicalGmailArchiveApprovalState');
    expect(source).not.toContain('GmailInboxMutationPort');
    expect(source).not.toContain('apps/api');
    expect(source).not.toContain('apps/worker');
  });
});
