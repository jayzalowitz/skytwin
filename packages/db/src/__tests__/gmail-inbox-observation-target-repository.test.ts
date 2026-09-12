import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../connection.js', () => ({ withTransaction: vi.fn() }));

const { gmailInboxObservationTargetTestHooks } = await import(
  '../repositories/gmail-inbox-observation-target-repository.js'
);

const permit = {
  userId: '11111111-1111-4111-8111-111111111111',
  approvalId: '22222222-2222-4222-8222-222222222222',
  admissionId: '33333333-3333-4333-8333-333333333333',
  messageRefId: '44444444-4444-4444-8444-444444444444',
  workKind: 'observe_dispatch' as const,
  barrierStatus: 'in_progress' as const,
  attemptPhase: 'dispatch_may_have_started' as const,
  phaseChangedAt: '2026-09-12T12:00:00.123456Z',
  leaseToken: '55555555-5555-4555-8555-555555555555',
  generation: 7,
  observationAttemptId: '66666666-6666-4666-8666-666666666666',
  authorizedAt: '2026-09-12T12:05:00.000Z',
  leaseExpiresAt: '2026-09-12T12:10:00.000Z',
  deadlineAt: '2026-09-12T12:07:30.000Z',
};
const selection = {
  connectorAccountId: '77777777-7777-4777-8777-777777777777',
  credentialRevision: '99999999-9999-4999-8999-999999999999',
  providerMessageId: 'native/message id',
};
const credentialRevision = '88888888-8888-4888-8888-888888888888';
const resolvedSelection = { ...selection, credentialRevision };
const row = {
  connector_account_id: selection.connectorAccountId,
  credential_revision: credentialRevision,
  provider_message_id: selection.providerMessageId,
};

function client(rows: unknown[] = [row]): PoolClient {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as PoolClient;
}

describe('permit-bound Gmail Inbox observation target', () => {
  it('strictly snapshots and freezes every permit field', () => {
    expect(gmailInboxObservationTargetTestHooks.snapshotPermit(permit)).toEqual(permit);
    expect(Object.isFrozen(gmailInboxObservationTargetTestHooks.snapshotPermit(permit))).toBe(true);
    expect(gmailInboxObservationTargetTestHooks.snapshotPermit({ ...permit, extra: true })).toBeNull();
  });

  it.each([
    ['userId', '99999999-9999-4999-8999-999999999999'],
    ['approvalId', '99999999-9999-4999-8999-999999999999'],
    ['admissionId', '99999999-9999-4999-8999-999999999999'],
    ['messageRefId', '99999999-9999-4999-8999-999999999999'],
    ['workKind', 'resume_claim'],
    ['barrierStatus', 'prepared'],
    ['attemptPhase', 'pre_dispatch'],
    ['phaseChangedAt', '2026-09-12T12:00:01.123456Z'],
    ['leaseToken', '99999999-9999-4999-8999-999999999999'],
    ['generation', 8],
    ['observationAttemptId', '99999999-9999-4999-8999-999999999999'],
    ['authorizedAt', '2026-09-12T12:05:01.000Z'],
    ['leaseExpiresAt', '2026-09-12T12:10:01.000Z'],
    ['deadlineAt', '2026-09-12T12:07:31.000Z'],
  ])('carries %s as exact query authority', async (field, changed) => {
    const changedPermit = { ...permit, [field]: changed };
    const queryClient = client([]);
    await gmailInboxObservationTargetTestHooks.resolvePermitInTransaction(
      queryClient,
      changedPermit,
      null,
    );
    const args = (queryClient.query as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(args).toContain(changed);
  });

  it('requires exactly one live target and binds final selection plus materialized revision', async () => {
    const queryClient = client();
    await expect(gmailInboxObservationTargetTestHooks.resolvePermitInTransaction(
      queryClient,
      permit,
      { selection, credentialRevision },
    )).resolves.toEqual(resolvedSelection);
    const [sql, args] = (queryClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain("lease.observation_state = 'started'");
    expect(sql).toContain('lease.expires_at > statement_timestamp()');
    expect(sql).toContain('lease.observation_deadline_at > statement_timestamp()');
    expect(sql).toContain('token.credential_revision = $20::UUID');
    expect(sql).toContain('LIMIT 2');
    expect(args.slice(0, 14)).toEqual([
      permit.admissionId, permit.userId, permit.approvalId, permit.messageRefId,
      permit.workKind, permit.barrierStatus, permit.attemptPhase, permit.phaseChangedAt,
      permit.leaseToken, permit.generation, permit.observationAttemptId, permit.authorizedAt,
      permit.deadlineAt, permit.leaseExpiresAt,
    ]);
    expect(args.slice(17)).toEqual([
      selection.connectorAccountId, selection.providerMessageId, credentialRevision,
    ]);
  });

  it.each([
    { name: 'missing', rows: [] },
    { name: 'duplicated', rows: [row, row] },
    { name: 'malformed', rows: [{ ...row, credential_revision: 'invalid' }] },
  ])(
    'rejects $name rows',
    async ({ rows }) => {
      await expect(gmailInboxObservationTargetTestHooks.resolvePermitInTransaction(
        client(rows), permit, null,
      )).resolves.toBeNull();
    },
  );

  it.each([
    ['deadline before fixed delta', { ...permit, deadlineAt: permit.authorizedAt }],
    ['lease expiry equal authorization', { ...permit, leaseExpiresAt: permit.authorizedAt }],
    ['lease expiry before authorization', {
      ...permit, leaseExpiresAt: '2026-09-12T12:04:59.999Z',
    }],
  ])('rejects invalid permit time relation: %s', (_name, value) => {
    expect(gmailInboxObservationTargetTestHooks.snapshotPermit(value)).toBeNull();
  });

  it('contains accessors, symbols, null prototypes, and hostile proxies before DB use', async () => {
    const getter = vi.fn(() => permit.userId);
    const accessor = { ...permit } as Record<string, unknown>;
    Object.defineProperty(accessor, 'userId', { enumerable: true, get: getter });
    const symbol = { ...permit };
    Object.defineProperty(symbol, Symbol('extra'), { enumerable: true, value: true });
    const revoked = Proxy.revocable({ ...permit }, {});
    revoked.revoke();
    const transaction = vi.fn();
    for (const submitted of [accessor, symbol, Object.assign(Object.create(null), permit), revoked.proxy]) {
      await expect(gmailInboxObservationTargetTestHooks.resolveInitialWithTransaction(
        submitted as typeof permit, transaction,
      )).resolves.toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('retries the complete snapshot-consistent query only on bounded serialization restarts', async () => {
    const queryClients: PoolClient[] = [];
    let attempt = 0;
    const transaction = async <T>(callback: (queryClient: PoolClient) => Promise<T>): Promise<T> => {
      attempt += 1;
      if (attempt < 3) throw Object.assign(new Error('restart'), { code: '40001' });
      const queryClient = client();
      queryClients.push(queryClient);
      return callback(queryClient);
    };
    await expect(gmailInboxObservationTargetTestHooks.resolveFinalWithTransaction({
      permit, selection, credentialRevision,
    }, transaction)).resolves.toEqual(resolvedSelection);
    expect(attempt).toBe(3);
    expect(queryClients).toHaveLength(1);
  });

  it('freezes permit, selection, and revision snapshots across retry and caller mutation', async () => {
    const seen: unknown[][] = [];
    const transaction = async <T>(callback: (queryClient: PoolClient) => Promise<T>): Promise<T> => {
      const queryClient = client();
      const result = await callback(queryClient);
      seen.push((queryClient.query as ReturnType<typeof vi.fn>).mock.calls[0]![1]);
      return result;
    };
    const submitted = {
      permit: { ...permit }, selection: { ...selection }, credentialRevision,
    };
    const pending = gmailInboxObservationTargetTestHooks.resolveFinalWithTransaction(
      submitted, transaction,
    );
    submitted.permit.generation = 99;
    submitted.selection.providerMessageId = 'swapped';
    await expect(pending).resolves.toEqual(resolvedSelection);
    expect(seen[0]?.[9]).toBe(permit.generation);
    expect(seen[0]?.[18]).toBe(selection.providerMessageId);
  });

  it('is SELECT-only and carries every account, ref, scope, state, time, and fence check', async () => {
    const source = await readFile(
      new URL('../repositories/gmail-inbox-observation-target-repository.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|UPSERT|FOR UPDATE)\b/i);
    for (const fragment of [
      'lease.approval_id = $3', 'lease.message_ref_id = $4', 'lease.lease_token = $9',
      'lease.generation = $10::INT8', 'lease.observation_attempt_id = $11',
      'lease.observation_authorized_at = $12::TIMESTAMPTZ',
      'lease.observation_deadline_at = $13::TIMESTAMPTZ',
      'lease.expires_at = $14::TIMESTAMPTZ', "barrier.status = 'in_progress'",
      "ref.provider = 'google'", 'account.is_active = true',
      'account.identity_verified = true', 'account.disconnected_at IS NULL',
      'ANY(account.scopes)', 'ANY(token.scopes)',
    ]) expect(source).toContain(fragment);
    expect(source).not.toContain('fetch(');
  });
});
