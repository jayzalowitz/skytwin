import { readFile, readdir } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, withTransactionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({ query: queryMock, withTransaction: withTransactionMock }));

const {
  gmailArchiveRecordedObservationReconciliationRepository,
  gmailArchiveRecordedObservationReconciliationTestHooks,
} = await import(
  '../repositories/gmail-archive-recorded-observation-reconciliation-repository.js'
);
const { consumeRecordedGmailArchiveObservationInTransaction } = await import(
  '../repositories/gmail-archive-recovery-lease-consumer.js'
);
const { gmailArchiveReconciliationTestHooks } = await import(
  '../repositories/gmail-archive-reconciliation-repository.js'
);

const fence = {
  userId: '11111111-1111-4111-8111-111111111111',
  approvalId: '22222222-2222-4222-8222-222222222222',
  admissionId: '33333333-3333-4333-8333-333333333333',
  messageRefId: '44444444-4444-4444-8444-444444444444',
  workKind: 'observe_dispatch' as const,
  barrierStatus: 'in_progress' as const,
  attemptPhase: 'dispatch_may_have_started' as const,
  phaseChangedAt: '2026-09-12T11:50:00.123456Z',
  leaseToken: '55555555-5555-4555-8555-555555555555',
  generation: 3,
};
const stable = {
  explanationId: '66666666-6666-4666-8666-666666666666',
  resultId: '77777777-7777-4777-8777-777777777777',
  revisionId: '88888888-8888-4888-8888-888888888888',
  persistedAt: '2026-09-12T12:00:00.000Z',
};
const observationAttemptId = '99999999-9999-4999-8999-999999999999';
const observedEvidence = {
  kind: 'mailbox_observed' as const,
  binding: {
    userId: fence.userId,
    admissionId: fence.admissionId,
    messageRefId: fence.messageRefId,
  },
  inbox: false,
  observedAt: '2026-09-12T11:55:01.000Z',
};

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    admission_id: fence.admissionId,
    user_id: fence.userId,
    approval_id: fence.approvalId,
    message_ref_id: fence.messageRefId,
    work_kind: fence.workKind,
    barrier_status: fence.barrierStatus,
    attempt_phase: fence.attemptPhase,
    phase_changed_at_text: '2026-09-12 11:50:00.123456',
    lease_token: fence.leaseToken,
    generation: String(fence.generation),
    observation_state: 'evidence_recorded',
    observation_attempt_id: observationAttemptId,
    observation_authorized_at: new Date('2026-09-12T11:55:00.000Z'),
    observation_deadline_at: new Date('2026-09-12T11:57:30.000Z'),
    observation_evidence: {
      schema: 'gmail_archive_recovery_observation_v1',
      evidence: observedEvidence,
    },
    ...overrides,
  };
}

async function sourceFilesBelow(directory: URL): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory() && ['__tests__', 'dist', 'node_modules'].includes(entry.name)) return [];
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) return sourceFilesBelow(child);
    return entry.name.endsWith('.ts') ? [await readFile(child, 'utf8')] : [];
  }));
  return nested.flat();
}

describe('gmailArchiveRecordedObservationReconciliationRepository', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ persisted_at: new Date(stable.persistedAt) }] });
    withTransactionMock.mockReset();
  });

  it.each([
    null,
    {},
    { ...fence, extra: true },
    { ...fence, userId: 'invalid' },
    { ...fence, approvalId: 'invalid' },
    { ...fence, admissionId: 'invalid' },
    { ...fence, messageRefId: 'invalid' },
    { ...fence, workKind: 'reconcile_pre_dispatch', attemptPhase: 'pre_dispatch' },
    { ...fence, barrierStatus: 'prepared' },
    { ...fence, attemptPhase: 'pre_dispatch' },
    { ...fence, phaseChangedAt: 'invalid' },
    { ...fence, leaseToken: 'invalid' },
    { ...fence, generation: 0 },
    { ...fence, generation: 1.5 },
  ])('rejects malformed or wrong-stage fences before DB work: %o', async (submitted) => {
    await expect(gmailArchiveRecordedObservationReconciliationRepository
      .reconcileRecordedObservation(submitted as never))
      .resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects accessors, symbols, non-enumerable fields, and revoked proxies', async () => {
    const getter = vi.fn(() => fence.userId);
    const accessor = { ...fence } as Record<string, unknown>;
    Object.defineProperty(accessor, 'userId', { enumerable: true, get: getter });
    const symbol = { ...fence };
    Object.defineProperty(symbol, Symbol('authority'), { enumerable: true, value: true });
    const hidden = { ...fence };
    Object.defineProperty(hidden, 'generation', { enumerable: false, value: fence.generation });
    const revoked = Proxy.revocable({ ...fence }, {});
    revoked.revoke();
    for (const submitted of [accessor, symbol, hidden, revoked.proxy]) {
      await expect(gmailArchiveRecordedObservationReconciliationRepository
        .reconcileRecordedObservation(submitted as never))
        .resolves.toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('freezes the fence and stable values once while rereading evidence on every 40001 retry', async () => {
    withTransactionMock.mockImplementation(async (callback) => callback({}));
    const snapshots: unknown[] = [];
    let attempts = 0;
    const submitted = { ...fence };
    const pending = gmailArchiveRecordedObservationReconciliationTestHooks
      .reconcileRecordedObservationWithTransition(
        submitted,
        async (_client, frozenFence, frozenStable) => {
          snapshots.push({ frozenFence, frozenStable });
          attempts += 1;
          if (attempts < 3) throw Object.assign(new Error('restart'), { code: '40001' });
          return { ok: true, reconciled: true };
        },
        () => stable,
      );
    submitted.leaseToken = stable.resultId;
    submitted.generation = 99;
    await expect(pending).resolves.toEqual({ ok: true, reconciled: true });
    expect(withTransactionMock).toHaveBeenCalledTimes(3);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[1]).toEqual(snapshots[2]);
    const first = snapshots[0] as { frozenFence: typeof fence; frozenStable: typeof stable };
    expect(first.frozenFence).toEqual(fence);
    expect(Object.isFrozen(first.frozenFence)).toBe(true);
    expect(first.frozenStable).toEqual(stable);
    expect(Object.isFrozen(first.frozenStable)).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('does not open a transaction before the stable DB clock reaches grace', async () => {
    await expect(gmailArchiveRecordedObservationReconciliationTestHooks
      .reconcileRecordedObservationWithTransition(
        fence,
        vi.fn(),
        () => ({ ...stable, persistedAt: '2026-09-12T11:54:59.999Z' }),
        async () => '2026-09-12T11:54:59.999Z',
        withTransactionMock,
      )).resolves.toEqual({ ok: false, error: 'not_ready' });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects hidden DB microsecond anchor drift unless immutable receipt truth carries it', () => {
    const driverTimestamp = new Date('2026-09-12T11:50:00.123Z');
    expect(gmailArchiveReconciliationTestHooks.exactReconciliationPhaseAnchor(
      '2026-09-12 11:50:00.123',
      driverTimestamp,
      '2026-09-12T11:40:00.000Z',
      '2026-09-12T11:50:00.123Z',
    )).toBe(true);
    expect(gmailArchiveReconciliationTestHooks.exactReconciliationPhaseAnchor(
      '2026-09-12 11:50:00.123456',
      driverTimestamp,
      '2026-09-12T11:40:00.000Z',
      '2026-09-12T11:50:00.123456Z',
    )).toBe(false);
    expect(gmailArchiveReconciliationTestHooks.exactReconciliationPhaseAnchor(
      '2026-09-12 11:50:00.123456',
      driverTimestamp,
      '2026-09-12T11:50:00.123456Z',
      '2026-09-12T11:50:00.123456Z',
    )).toBe(true);
  });

  it.each(['08006', '40003'])('maps ambiguous %s commits without retry', async (code) => {
    const transaction = vi.fn().mockRejectedValue(
      Object.assign(new Error('commit uncertain'), { code }),
    );
    await expect(gmailArchiveRecordedObservationReconciliationTestHooks
      .reconcileRecordedObservationWithTransition(
        fence,
        vi.fn(),
        () => stable,
        async () => stable.persistedAt,
        transaction,
      )).resolves.toEqual({ ok: false, error: 'commit_unverified' });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('exhausts 40001 and does not mask ordinary database failures', async () => {
    const restart = Object.assign(new Error('restart exhausted'), { code: '40001' });
    const restarting = vi.fn().mockRejectedValue(restart);
    await expect(gmailArchiveRecordedObservationReconciliationTestHooks
      .reconcileRecordedObservationWithTransition(
        fence,
        vi.fn(),
        () => stable,
        async () => stable.persistedAt,
        restarting,
      )).rejects.toBe(restart);
    expect(restarting).toHaveBeenCalledTimes(3);

    const constraint = Object.assign(new Error('constraint'), { code: '23514' });
    const ordinary = vi.fn().mockRejectedValue(constraint);
    await expect(gmailArchiveRecordedObservationReconciliationTestHooks
      .reconcileRecordedObservationWithTransition(
        fence,
        vi.fn(),
        () => stable,
        async () => stable.persistedAt,
        ordinary,
      )).rejects.toBe(constraint);
    expect(ordinary).toHaveBeenCalledTimes(1);
  });

  it('derives and consumes exact observed evidence without checking lease expiry', async () => {
    const row = leaseRow({
      expires_at: new Date('2026-09-12T11:54:00.000Z'),
    });
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ admission_id: fence.admissionId }] });
    await expect(consumeRecordedGmailArchiveObservationInTransaction(
      { query: clientQuery } as unknown as PoolClient,
      fence,
    )).resolves.toEqual({ ok: true, evidence: observedEvidence });
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(clientQuery.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('observation_attempt_id = $11::UUID');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('observation_evidence = $14::JSONB');
    expect(clientQuery.mock.calls[1]?.[0]).not.toContain('expires_at');
    expect(clientQuery.mock.calls[1]?.[1]).toEqual([
      fence.admissionId, fence.userId, fence.approvalId, fence.messageRefId,
      fence.workKind, fence.barrierStatus, fence.attemptPhase, fence.phaseChangedAt,
      fence.leaseToken, fence.generation, observationAttemptId,
      '2026-09-12T11:55:00.000Z', '2026-09-12T11:57:30.000Z',
      JSON.stringify(row.observation_evidence),
    ]);
  });

  it('derives unavailable evidence even when persistence follows its deadline', async () => {
    const evidence = {
      kind: 'mailbox_observation_unavailable' as const,
      binding: observedEvidence.binding,
      code: 'observation_unavailable' as const,
    };
    const row = leaseRow({
      observation_evidence: {
        schema: 'gmail_archive_recovery_observation_v1',
        evidence,
      },
    });
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ admission_id: fence.admissionId }] });
    await expect(consumeRecordedGmailArchiveObservationInTransaction(
      { query: clientQuery } as unknown as PoolClient,
      fence,
    )).resolves.toEqual({ ok: true, evidence });
  });

  it.each([
    ['user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['approval_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['admission_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['message_ref_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['work_kind', 'reconcile_pre_dispatch'],
    ['barrier_status', 'prepared'],
    ['attempt_phase', 'pre_dispatch'],
    ['phase_changed_at_text', '2026-09-12 11:50:00.123455'],
    ['lease_token', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['generation', '4'],
  ] as const)('rejects exact stored fence mismatch %s without delete', async (column, value) => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [leaseRow({ [column]: value })] });
    await expect(consumeRecordedGmailArchiveObservationInTransaction(
      { query: clientQuery } as unknown as PoolClient,
      fence,
    )).resolves.toEqual({ ok: false, error: 'stale_lease' });
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it.each(['not_started', 'started'] as const)(
    'leaves %s observation state unconsumed and not ready',
    async (observationState) => {
      const clientQuery = vi.fn().mockResolvedValue({ rows: [leaseRow({
        observation_state: observationState,
        observation_evidence: null,
      })] });
      await expect(consumeRecordedGmailArchiveObservationInTransaction(
        { query: clientQuery } as unknown as PoolClient,
        fence,
      )).resolves.toEqual({ ok: false, error: 'not_ready' });
      expect(clientQuery).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects truncated authorization before a microsecond phase and malformed retained evidence', async () => {
    const cases = [
      leaseRow({
        observation_authorized_at: new Date('2026-09-12T11:50:00.123Z'),
        observation_deadline_at: new Date('2026-09-12T11:52:30.123Z'),
        observation_evidence: {
          schema: 'gmail_archive_recovery_observation_v1',
          evidence: { ...observedEvidence, observedAt: '2026-09-12T11:50:00.124Z' },
        },
      }),
      leaseRow({ observation_attempt_id: 'invalid' }),
      leaseRow({ observation_evidence: { schema: 'wrong', evidence: observedEvidence } }),
      leaseRow({
        observation_evidence: {
          schema: 'gmail_archive_recovery_observation_v1',
          evidence: {
            ...observedEvidence,
            binding: { ...observedEvidence.binding, messageRefId: fence.approvalId },
          },
        },
      }),
    ];
    for (const row of cases) {
      const clientQuery = vi.fn().mockResolvedValue({ rows: [row] });
      await expect(consumeRecordedGmailArchiveObservationInTransaction(
        { query: clientQuery } as unknown as PoolClient,
        fence,
      )).resolves.toEqual({ ok: false, error: 'integrity_conflict' });
      expect(clientQuery).toHaveBeenCalledTimes(1);
    }
  });

  it('stays leaf-only, DB-only, and absent from runtime composition', async () => {
    const source = await readFile(
      new URL(
        '../repositories/gmail-archive-recorded-observation-reconciliation-repository.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).not.toMatch(/@skytwin\/(?:connectors|credential-vault|execution-router|ironclaw-adapter)/);
    expect(source).not.toMatch(/\bfetch\s*\(|https?:\/\/|\/modify\b|\bPOST\b/);
    expect(source).not.toContain('gmailArchiveReconciliationRepository.reconcile');
    const core = await readFile(
      new URL('../repositories/gmail-archive-reconciliation-repository.ts', import.meta.url),
      'utf8',
    );
    const recordedCore = core.slice(core.indexOf(
      'export async function reconcileRecordedGmailArchiveObservationInTransaction',
    ));
    const barrierLock = recordedCore.indexOf('FROM pre_effect_barriers AS barrier');
    const baselineValidation = recordedCore.indexOf('exactGmailArchiveInProgressBaseline');
    const leaseConsumption = recordedCore.indexOf(
      'consumeRecordedGmailArchiveObservationInTransaction',
    );
    expect(barrierLock).toBeGreaterThanOrEqual(0);
    expect(baselineValidation).toBeGreaterThan(barrierLock);
    expect(leaseConsumption).toBeGreaterThan(baselineValidation);
    const barrels = await Promise.all([
      readFile(new URL('../repositories/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../index.ts', import.meta.url), 'utf8'),
    ]);
    for (const barrel of barrels) {
      expect(barrel).not.toContain('gmailArchiveRecordedObservationReconciliationRepository');
      expect(barrel).not.toContain('gmail-archive-recorded-observation-reconciliation-repository');
    }
    const roots = [
      new URL('../../../../apps/api/', import.meta.url),
      new URL('../../../../apps/worker/', import.meta.url),
      new URL('../../../../apps/desktop/', import.meta.url),
      new URL('../../../execution-router/', import.meta.url),
      new URL('../../../ironclaw-adapter/', import.meta.url),
    ];
    const runtimeSources = (await Promise.all(roots.map(sourceFilesBelow))).flat().join('\n');
    expect(runtimeSources).not.toContain('gmailArchiveRecordedObservationReconciliationRepository');
    expect(runtimeSources).not.toContain('reconcileRecordedObservation');
  });
});
