import { readFile, readdir } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../connection.js', () => ({ withTransaction: vi.fn() }));
vi.mock('../repositories/gmail-archive-approval-response-repository.js', () => ({
  canonicalGmailArchiveApprovalContent: vi.fn(),
  canonicalGmailArchiveCandidateMessageRef: vi.fn(),
  loadCanonicalGmailArchiveApprovalState: vi.fn(),
}));
vi.mock('../repositories/gmail-archive-preparation-repository.js', () => ({
  loadGmailArchivePreparationReplay: vi.fn(),
}));
vi.mock('../repositories/gmail-archive-recovery-repository.js', () => ({
  queryAbandonedGmailArchiveInTransaction: vi.fn(),
}));
vi.mock('../repositories/gmail-archive-claim-integrity.js', () => ({
  exactClaimedGmailArchiveReceipt: vi.fn(),
}));
vi.mock('../repositories/gmail-archive-terminalization-repository.js', () => ({
  exactGmailArchiveApprovedPrefix: vi.fn(),
  loadGmailArchivePolicyExplanation: vi.fn(),
  loadGmailArchiveStableState: vi.fn(),
}));

const { gmailArchiveRecoveryLeaseTestHooks } = await import(
  '../repositories/gmail-archive-recovery-lease-repository.js'
);
const {
  consumeGmailArchiveRecoveryLeaseInTransaction,
  gmailArchiveRecoveryLeaseConsumerTestHooks,
} = await import(
  '../repositories/gmail-archive-recovery-lease-consumer.js'
);

const authority = {
  userId: '11111111-1111-4111-8111-111111111111',
  approvalId: '22222222-2222-4222-8222-222222222222',
  leaseMs: 30_000,
};

const fence = {
  userId: authority.userId,
  approvalId: authority.approvalId,
  admissionId: '33333333-3333-4333-8333-333333333333',
  messageRefId: '44444444-4444-4444-8444-444444444444',
  workKind: 'observe_dispatch' as const,
  barrierStatus: 'in_progress' as const,
  attemptPhase: 'dispatch_may_have_started' as const,
  phaseChangedAt: '2026-09-12T12:00:00.123456Z',
  leaseToken: '55555555-5555-4555-8555-555555555555',
  generation: 2,
};

const permit = {
  ...fence,
  observationAttemptId: '66666666-6666-4666-8666-666666666666',
  authorizedAt: '2026-09-12T12:05:00.000Z',
  deadlineAt: '2026-09-12T12:07:30.000Z',
};

const observedEvidence = {
  kind: 'mailbox_observed' as const,
  binding: {
    userId: fence.userId,
    admissionId: fence.admissionId,
    messageRefId: fence.messageRefId,
  },
  inbox: false,
  observedAt: '2026-09-12T12:05:10.000Z',
};

function recoveryLeaseRow(overrides: Record<string, unknown> = {}) {
  return {
    admission_id: fence.admissionId,
    user_id: fence.userId,
    approval_id: fence.approvalId,
    message_ref_id: fence.messageRefId,
    work_kind: fence.workKind,
    barrier_status: fence.barrierStatus,
    attempt_phase: fence.attemptPhase,
    phase_changed_at: new Date('2026-09-12T12:00:00.123Z'),
    phase_changed_at_text: '2026-09-12 12:00:00.123456',
    lease_token: fence.leaseToken,
    generation: String(fence.generation),
    acquired_at: new Date('2026-09-12T12:04:00.000Z'),
    renewed_at: new Date('2026-09-12T12:04:00.000Z'),
    expires_at: new Date('2026-09-12T12:04:30.000Z'),
    observation_state: 'evidence_recorded',
    observation_attempt_id: permit.observationAttemptId,
    observation_authorized_at: new Date(permit.authorizedAt),
    observation_deadline_at: new Date(permit.deadlineAt),
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
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) return sourceFilesBelow(child);
    return /\.(?:ts|js)$/.test(entry.name) ? [await readFile(child, 'utf8')] : [];
  }));
  return nested.flat();
}

describe('gmailArchiveRecoveryLeaseRepository boundary', () => {
  it.each([
    null,
    {},
    { ...authority, extra: true },
    { ...authority, userId: 'invalid' },
    { ...authority, approvalId: 'A2222222-2222-4222-8222-222222222222' },
    { ...authority, leaseMs: 999 },
    { ...authority, leaseMs: 300_001 },
    { ...authority, leaseMs: 1_000.5 },
  ])('rejects malformed acquire input before a transaction: %o', async (submitted) => {
    const transaction = vi.fn();
    await expect(gmailArchiveRecoveryLeaseTestHooks.acquireWithTransition(
      submitted as never,
      vi.fn(),
      transaction,
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('contains symbols, accessors, null prototypes, and hostile proxies', async () => {
    const symbol = { ...authority };
    Object.defineProperty(symbol, Symbol('extra'), { value: true });
    const getter = vi.fn(() => authority.userId);
    const accessor = { approvalId: authority.approvalId, leaseMs: authority.leaseMs };
    Object.defineProperty(accessor, 'userId', { enumerable: true, get: getter });
    const nullPrototype = Object.assign(Object.create(null), authority);
    const revoked = Proxy.revocable({ ...authority }, {});
    revoked.revoke();
    const transaction = vi.fn();

    for (const submitted of [symbol, accessor, nullPrototype, revoked.proxy]) {
      await expect(gmailArchiveRecoveryLeaseTestHooks.acquireWithTransition(
        submitted as never,
        vi.fn(),
        transaction,
      )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reuses one frozen authority snapshot and lease token across 40001 retries', async () => {
    const seenInputs: unknown[] = [];
    const tokens: string[] = [];
    const transition = vi.fn(async (
      _client: PoolClient,
      input: unknown,
      token: string,
    ) => {
      seenInputs.push(input);
      tokens.push(token);
      if (tokens.length < 3) throw Object.assign(new Error('restart'), { code: '40001' });
      return { ok: true as const, status: 'not_due' as const, lease: null };
    });
    const transaction = async <T>(callback: (client: PoolClient) => Promise<T>) =>
      callback({} as PoolClient);

    await expect(gmailArchiveRecoveryLeaseTestHooks.acquireWithTransition(
      authority,
      transition,
      transaction,
    )).resolves.toEqual({ ok: true, status: 'not_due', lease: null });
    expect(new Set(tokens).size).toBe(1);
    expect(seenInputs.every((input) => input === seenInputs[0])).toBe(true);
    expect(Object.isFrozen(seenInputs[0])).toBe(true);
  });

  it('reuses one observation-attempt id across begin retries without returning a second permit', async () => {
    const ids: string[] = [];
    const transition = vi.fn(async (
      _client: PoolClient,
      _snapshot: unknown,
      observationAttemptId: string,
    ) => {
      ids.push(observationAttemptId);
      if (ids.length === 1) throw Object.assign(new Error('restart'), { code: '40001' });
      return { ok: true as const, status: 'already_started' as const, permit: null };
    });
    const transaction = async <T>(callback: (client: PoolClient) => Promise<T>) =>
      callback({} as PoolClient);

    await expect(gmailArchiveRecoveryLeaseTestHooks.beginWithTransition(
      fence,
      transition,
      transaction,
    )).resolves.toEqual({ ok: true, status: 'already_started', permit: null });
    expect(new Set(ids).size).toBe(1);
  });

  it('samples record request time before locking and allows an exact replay after expiry', async () => {
    const requestTime = new Date('2026-09-12T12:06:00.000Z');
    const evidence = {
      kind: 'mailbox_observation_unavailable' as const,
      binding: {
        userId: permit.userId,
        admissionId: permit.admissionId,
        messageRefId: permit.messageRefId,
      },
      code: 'observation_unavailable' as const,
    };
    const transition = vi.fn().mockResolvedValue({
      ok: true,
      recorded: false,
      evidence,
    });
    const transaction = async <T>(callback: (client: PoolClient) => Promise<T>) =>
      callback({} as PoolClient);

    await expect(gmailArchiveRecoveryLeaseTestHooks.recordWithTransition(
      { permit, evidence },
      transition,
      transaction,
      async () => requestTime,
    )).resolves.toEqual({ ok: true, recorded: false, evidence });
    expect(transition).toHaveBeenCalledWith(expect.anything(), expect.anything(), requestTime);
  });

  it.each([
    { ...fence, extra: true },
    { ...fence, generation: 0 },
    { ...fence, leaseToken: 'bad' },
    { ...fence, attemptPhase: 'pre_dispatch' },
    { ...fence, phaseChangedAt: 'not-a-time' },
    { ...fence, phaseChangedAt: '2026-02-31T12:00:00.123456Z' },
  ])('rejects malformed or internally inconsistent fences: %o', (submitted) => {
    expect(gmailArchiveRecoveryLeaseTestHooks.snapshotFence(submitted)).toBeNull();
  });

  it('keeps issuer and consumer fence parsers in exact parity', () => {
    const corpus: unknown[] = [
      fence,
      { ...fence, workKind: 'reconcile_pre_dispatch', attemptPhase: 'pre_dispatch' },
      {
        ...fence,
        workKind: 'resume_preparation',
        barrierStatus: 'reserved',
        attemptPhase: null,
      },
      {
        ...fence,
        workKind: 'resume_claim',
        barrierStatus: 'prepared',
        attemptPhase: null,
      },
      null,
      {},
      { ...fence, extra: true },
      { ...fence, generation: 0 },
      { ...fence, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...fence, leaseToken: 'invalid' },
      { ...fence, attemptPhase: 'pre_dispatch' },
      { ...fence, phaseChangedAt: '2026-02-31T12:00:00.123456Z' },
      { ...fence, phaseChangedAt: '2026-09-12T12:00:00.123456+00:00' },
    ];
    for (const value of corpus) {
      expect(gmailArchiveRecoveryLeaseConsumerTestHooks.snapshotFence(value)).toEqual(
        gmailArchiveRecoveryLeaseTestHooks.snapshotFence(value),
      );
    }
  });

  it('canonicalizes only exact UTC DB phase strings while preserving microseconds', () => {
    const canonicalize = gmailArchiveRecoveryLeaseTestHooks.canonicalDbPhaseTimestamp;
    expect(canonicalize('2026-09-12 12:00:00.123')).toBe('2026-09-12T12:00:00.123Z');
    expect(canonicalize('2026-09-12 12:00:00.123000')).toBe('2026-09-12T12:00:00.123Z');
    expect(canonicalize('2026-09-12 12:00:00.123456')).toBe('2026-09-12T12:00:00.123456Z');
    expect(canonicalize('2026-02-31 12:00:00.123456')).toBeNull();
    expect(canonicalize('2026-09-12 12:00:00.123456+00:00')).toBeNull();
  });

  it('requires exact bound, secret-free observation evidence', () => {
    const evidence = {
      kind: 'mailbox_observed',
      binding: {
        userId: permit.userId,
        admissionId: permit.admissionId,
        messageRefId: permit.messageRefId,
      },
      inbox: false,
      observedAt: '2026-09-12T12:05:10.000Z',
    };
    expect(gmailArchiveRecoveryLeaseTestHooks.snapshotEvidence(evidence)).toEqual(evidence);
    expect(gmailArchiveRecoveryLeaseTestHooks.snapshotEvidence({
      ...evidence,
      accessToken: 'secret',
    })).toBeNull();
    expect(gmailArchiveRecoveryLeaseTestHooks.snapshotEvidence({
      ...evidence,
      observedAt: '2026-09-12T12:05:10.123456Z',
    })).toBeNull();
    expect(gmailArchiveRecoveryLeaseTestHooks.snapshotEvidence({
      ...evidence,
      binding: { ...evidence.binding, admissionId: authority.approvalId },
    })).not.toBeNull();
  });

  it('keeps issuer and consumer evidence parsers in exact parity', () => {
    const unavailable = {
      kind: 'mailbox_observation_unavailable',
      binding: observedEvidence.binding,
      code: 'observation_unavailable',
    };
    const corpus: unknown[] = [
      observedEvidence,
      unavailable,
      null,
      {},
      { ...observedEvidence, extra: true },
      { ...observedEvidence, inbox: 'false' },
      { ...observedEvidence, observedAt: '2026-09-12T12:05:10.123456Z' },
      { ...observedEvidence, binding: { ...observedEvidence.binding, userId: 'invalid' } },
      { ...unavailable, code: 'invalid_command' },
      { ...unavailable, accessToken: 'secret' },
    ];
    for (const value of corpus) {
      expect(gmailArchiveRecoveryLeaseConsumerTestHooks.snapshotEvidence(value)).toEqual(
        gmailArchiveRecoveryLeaseTestHooks.snapshotEvidence(value),
      );
    }
  });

  it('rejects retained evidence with crossed authority or impossible timing', () => {
    const evidence = {
      schema: 'gmail_archive_recovery_observation_v1',
      evidence: {
        kind: 'mailbox_observed',
        binding: {
          userId: fence.userId,
          admissionId: fence.admissionId,
          messageRefId: fence.messageRefId,
        },
        inbox: false,
        observedAt: '2026-09-12T12:05:10.000Z',
      },
    };
    const row = {
      admission_id: fence.admissionId,
      user_id: fence.userId,
      approval_id: fence.approvalId,
      message_ref_id: fence.messageRefId,
      work_kind: fence.workKind,
      barrier_status: fence.barrierStatus,
      attempt_phase: fence.attemptPhase,
      phase_changed_at: new Date(fence.phaseChangedAt),
      lease_token: fence.leaseToken,
      generation: String(fence.generation),
      acquired_at: new Date('2026-09-12T12:04:00.000Z'),
      renewed_at: new Date('2026-09-12T12:04:00.000Z'),
      expires_at: new Date('2026-09-12T12:10:00.000Z'),
      observation_state: 'evidence_recorded',
      observation_attempt_id: permit.observationAttemptId,
      observation_authorized_at: new Date(permit.authorizedAt),
      observation_deadline_at: new Date(permit.deadlineAt),
      observation_evidence: evidence,
    };
    expect(gmailArchiveRecoveryLeaseTestHooks.leaseFromRow(
      row as never,
      fence.phaseChangedAt,
    )).toMatchObject({ evidence: evidence.evidence });
    expect(gmailArchiveRecoveryLeaseTestHooks.leaseFromRow({
      ...row,
      observation_evidence: {
        ...evidence,
        evidence: {
          ...evidence.evidence,
          binding: { ...evidence.evidence.binding, messageRefId: authority.approvalId },
        },
      },
    } as never, fence.phaseChangedAt)).toBeNull();
    expect(gmailArchiveRecoveryLeaseTestHooks.leaseFromRow({
      ...row,
      observation_evidence: {
        ...evidence,
        evidence: { ...evidence.evidence, observedAt: '2026-09-12T12:04:59.999Z' },
      },
    } as never, fence.phaseChangedAt)).toBeNull();
    expect(gmailArchiveRecoveryLeaseTestHooks.leaseFromRow({
      ...row,
      observation_evidence: {
        ...evidence,
        evidence: { ...evidence.evidence, observedAt: '2026-09-12T12:07:30.001Z' },
      },
    } as never, fence.phaseChangedAt)).toBeNull();
    expect(gmailArchiveRecoveryLeaseTestHooks.leaseFromRow({
      ...row,
      observation_deadline_at: new Date('2026-09-12T12:07:29.999Z'),
    } as never, fence.phaseChangedAt)).toBeNull();
  });

  it('consumes an exact recorded observation with every fence and evidence predicate', async () => {
    const row = recoveryLeaseRow();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ admission_id: fence.admissionId }] });
    await expect(consumeGmailArchiveRecoveryLeaseInTransaction(
      { query } as unknown as PoolClient,
      {
        fence,
        observationAttemptId: permit.observationAttemptId,
        evidence: observedEvidence,
      },
    )).resolves.toEqual({ ok: true, evidence: observedEvidence });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('DELETE FROM gmail_archive_recovery_leases');
    expect(query.mock.calls[1]?.[0]).toContain('lease_token = $9 AND generation = $10::INT8');
    expect(query.mock.calls[1]?.[0]).toContain('observation_attempt_id IS NOT DISTINCT FROM $12::UUID');
    expect(query.mock.calls[1]?.[0]).toContain('observation_evidence IS NOT DISTINCT FROM $13::JSONB');
    expect(query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      fence.leaseToken,
      fence.generation,
      permit.observationAttemptId,
      JSON.stringify(row.observation_evidence),
    ]));
  });

  it('rejects hostile consumer inputs without invoking accessors or querying', async () => {
    const getter = vi.fn(() => fence);
    const accessor = {
      observationAttemptId: permit.observationAttemptId,
      evidence: observedEvidence,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'fence', { enumerable: true, get: getter });
    const revoked = Proxy.revocable({
      fence,
      observationAttemptId: permit.observationAttemptId,
      evidence: observedEvidence,
    }, {});
    revoked.revoke();
    for (const submitted of [
      accessor,
      { fence, observationAttemptId: permit.observationAttemptId, evidence: observedEvidence, extra: true },
      revoked.proxy,
    ]) {
      const query = vi.fn();
      await expect(consumeGmailArchiveRecoveryLeaseInTransaction(
        { query } as unknown as PoolClient,
        submitted as never,
      )).resolves.toEqual({ ok: false, error: 'invalid_input' });
      expect(query).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('consumes an expired but unsuperseded pre-dispatch generation without observation state', async () => {
    const preFence = {
      ...fence,
      workKind: 'reconcile_pre_dispatch' as const,
      attemptPhase: 'pre_dispatch' as const,
    };
    const row = recoveryLeaseRow({
      work_kind: preFence.workKind,
      attempt_phase: preFence.attemptPhase,
      observation_state: 'not_started',
      observation_attempt_id: null,
      observation_authorized_at: null,
      observation_deadline_at: null,
      observation_evidence: null,
    });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ admission_id: fence.admissionId }] });
    await expect(consumeGmailArchiveRecoveryLeaseInTransaction(
      { query } as unknown as PoolClient,
      { fence: preFence, observationAttemptId: null, evidence: null },
    )).resolves.toEqual({ ok: true, evidence: null });
    expect((query.mock.calls[1]?.[0] as string)).not.toContain('expires_at >');
  });

  it('does not delete a stale generation, unfinished observation, or conflicting evidence', async () => {
    const cases = [
      {
        row: recoveryLeaseRow({ generation: String(fence.generation + 1) }),
        input: { fence, observationAttemptId: permit.observationAttemptId, evidence: observedEvidence },
        error: 'stale_lease',
      },
      {
        row: recoveryLeaseRow({
          observation_state: 'started',
          observation_evidence: null,
        }),
        input: { fence, observationAttemptId: permit.observationAttemptId, evidence: observedEvidence },
        error: 'not_ready',
      },
      {
        row: recoveryLeaseRow(),
        input: {
          fence,
          observationAttemptId: permit.observationAttemptId,
          evidence: { ...observedEvidence, inbox: true },
        },
        error: 'evidence_conflict',
      },
      {
        row: recoveryLeaseRow({
          observation_deadline_at: new Date('2026-09-12T12:07:29.999Z'),
        }),
        input: { fence, observationAttemptId: permit.observationAttemptId, evidence: observedEvidence },
        error: 'integrity_conflict',
      },
    ] as const;
    for (const current of cases) {
      const query = vi.fn().mockResolvedValue({ rows: [current.row] });
      await expect(consumeGmailArchiveRecoveryLeaseInTransaction(
        { query } as unknown as PoolClient,
        current.input,
      )).resolves.toEqual({ ok: false, error: current.error });
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects crossed evidence before a transaction', async () => {
    const transaction = vi.fn();
    await expect(gmailArchiveRecoveryLeaseTestHooks.recordWithTransition({
      permit,
      evidence: {
        kind: 'mailbox_observation_unavailable',
        binding: {
          userId: permit.userId,
          admissionId: permit.admissionId,
          messageRefId: authority.approvalId,
        },
        code: 'observation_unavailable',
      },
    }, vi.fn(), transaction)).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['08006', '40003'])('maps ambiguous %s commits for every write boundary', async (code) => {
    const transaction = vi.fn().mockRejectedValue(
      Object.assign(new Error('commit outcome unavailable'), { code }),
    );
    const transition = vi.fn();
    const evidence = {
      kind: 'mailbox_observation_unavailable' as const,
      binding: {
        userId: permit.userId,
        admissionId: permit.admissionId,
        messageRefId: permit.messageRefId,
      },
      code: 'observation_unavailable' as const,
    };
    const calls = [
      gmailArchiveRecoveryLeaseTestHooks.acquireWithTransition(authority, transition, transaction),
      gmailArchiveRecoveryLeaseTestHooks.beginWithTransition(fence, transition, transaction),
      gmailArchiveRecoveryLeaseTestHooks.recordWithTransition(
        { permit, evidence },
        transition,
        transaction,
        async () => new Date('2026-09-12T12:05:10.000Z'),
      ),
      gmailArchiveRecoveryLeaseTestHooks.renewWithTransition(
        fence,
        60_000,
        transition,
        transaction,
      ),
    ];
    await expect(Promise.all(calls)).resolves.toEqual(Array.from(
      { length: 4 },
      () => ({ ok: false, error: 'commit_unverified' }),
    ));
    expect(transition).not.toHaveBeenCalled();
  });

  it('does not mask an ordinary database failure as commit ambiguity', async () => {
    const error = Object.assign(new Error('check violation'), { code: '23514' });
    const transaction = vi.fn().mockRejectedValue(error);
    await expect(gmailArchiveRecoveryLeaseTestHooks.renewWithTransition(
      fence,
      60_000,
      vi.fn(),
      transaction,
    )).rejects.toBe(error);
  });

  it('contains no runtime/provider/OAuth boundary and remains unwired', async () => {
    const source = await readFile(
      new URL('../repositories/gmail-archive-recovery-lease-repository.ts', import.meta.url),
      'utf8',
    );
    const consumer = await readFile(
      new URL('../repositories/gmail-archive-recovery-lease-consumer.ts', import.meta.url),
      'utf8',
    );
    for (const boundary of [source, consumer]) {
      expect(boundary).not.toMatch(/@skytwin\/(?:connectors|credential-vault|execution-router|ironclaw-adapter)/);
      expect(boundary).not.toMatch(/\bfetch\s*\(|https?:\/\/|\/modify\b|\bPOST\b/);
      expect(boundary).not.toMatch(/apps\/(?:api|worker)/);
    }
    const roots = [
      new URL('../../../../apps/api/', import.meta.url),
      new URL('../../../../apps/worker/', import.meta.url),
      new URL('../../../../apps/desktop/', import.meta.url),
      new URL('../../../execution-router/', import.meta.url),
      new URL('../../../ironclaw-adapter/', import.meta.url),
    ];
    const runtimeSources = (await Promise.all(roots.map(sourceFilesBelow))).flat().join('\n');
    expect(runtimeSources).not.toContain('gmailArchiveRecoveryLeaseRepository');
    expect(runtimeSources).not.toContain('GmailArchiveRecoveryLeaseFence');
    expect(runtimeSources).not.toContain('gmail-archive-recovery-lease-consumer');
    expect(runtimeSources).not.toContain('consumeGmailArchiveRecoveryLeaseInTransaction');
    const barrels = await Promise.all([
      readFile(new URL('../repositories/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../index.ts', import.meta.url), 'utf8'),
    ]);
    for (const barrel of barrels) {
      expect(barrel).not.toContain('gmail-archive-recovery-lease-consumer');
      expect(barrel).not.toContain('consumeGmailArchiveRecoveryLeaseInTransaction');
    }
  });
});
