import { readFile, readdir } from 'node:fs/promises';
import type { GmailArchiveReconciliationEvidence } from '@skytwin/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, withTransactionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({ query: queryMock, withTransaction: withTransactionMock }));

const {
  buildGmailArchiveReconciliationTerminalEnvelope,
  gmailArchiveReconciliationEvidenceAllowedForPhase,
  gmailArchiveReconciliationExplanationSemantics,
  gmailArchiveReconciliationRepository,
  gmailArchiveReconciliationTestHooks,
  parseGmailArchiveReconciliationExplanationEvidence,
  parseGmailArchiveReconciliationTerminalEnvelope,
} = await import('../repositories/gmail-archive-reconciliation-repository.js');

const command = {
  userId: '11111111-1111-4111-8111-111111111111',
  admissionId: '22222222-2222-4222-8222-222222222222',
  messageRefId: '33333333-3333-4333-8333-333333333333',
  operation: 'reconcile_archive' as const,
};
const binding = {
  userId: command.userId,
  admissionId: command.admissionId,
  messageRefId: command.messageRefId,
};
const interrupted = { kind: 'interrupted_before_dispatch' as const };
const observedOutsideInbox = {
  kind: 'mailbox_observed' as const,
  binding,
  inbox: false,
  observedAt: '2026-09-12T12:00:00.000Z',
};
const observedInInbox = { ...observedOutsideInbox, inbox: true };
const unavailable = {
  kind: 'mailbox_observation_unavailable' as const,
  binding,
  code: 'observation_unavailable' as const,
};
const phaseChangedAt = '2026-09-12T11:50:00.000Z';
const recovery = {
  fence: {
    userId: command.userId,
    approvalId: '77777777-7777-4777-8777-777777777777',
    admissionId: command.admissionId,
    messageRefId: command.messageRefId,
    workKind: 'observe_dispatch' as const,
    barrierStatus: 'in_progress' as const,
    attemptPhase: 'dispatch_may_have_started' as const,
    phaseChangedAt,
    leaseToken: '88888888-8888-4888-8888-888888888888',
    generation: 3,
  },
  observationAttemptId: '99999999-9999-4999-8999-999999999999',
};
const stable = {
  explanationId: '44444444-4444-4444-8444-444444444444',
  resultId: '55555555-5555-4555-8555-555555555555',
  revisionId: '66666666-6666-4666-8666-666666666666',
  persistedAt: '2026-09-12T12:00:01.000Z',
};

function input(evidence: GmailArchiveReconciliationEvidence = observedOutsideInbox) {
  return {
    command,
    recovery,
    evidence,
  };
}

function envelopeInput(evidence: GmailArchiveReconciliationEvidence = observedOutsideInbox) {
  return { phase: 'dispatch_may_have_started' as const, phaseChangedAt, evidence };
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

describe('gmailArchiveReconciliationRepository boundary', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ persisted_at: new Date(stable.persistedAt) }] });
    withTransactionMock.mockReset();
  });

  it.each([
    null,
    {},
    { ...input(), extra: true },
    { ...input(), command: { ...command, operation: 'archive' } },
    { ...input(), command: { ...command, userId: 'invalid' } },
    { ...input(), command: { ...command, admissionId: 'invalid' } },
    { ...input(), command: { ...command, messageRefId: 'invalid' } },
    { ...input(), recovery: { ...recovery, fence: {
      ...recovery.fence,
      workKind: 'reconcile_pre_dispatch',
      attemptPhase: 'pre_dispatch',
    } } },
    { ...input(interrupted), phase: 'dispatch_may_have_started' },
    { ...input(), recovery: { ...recovery, observationAttemptId: null } },
    { ...input(), recovery: { ...recovery, observationAttemptId: 'invalid' } },
    { ...input(), recovery: { ...recovery, fence: {
      ...recovery.fence,
      phaseChangedAt: 'not-an-instant',
    } } },
    { ...input(), recovery: { ...recovery, fence: {
      ...recovery.fence,
      userId: command.admissionId,
    } } },
    { ...input({ ...observedOutsideInbox, extra: true } as never) },
    { ...input({ ...observedOutsideInbox, observedAt: 'not-an-instant' }) },
    { ...input({ ...observedOutsideInbox, binding: undefined } as never) },
    { ...input({ ...observedOutsideInbox, binding: { ...binding, userId: command.admissionId } }) },
    { ...input({ ...observedOutsideInbox, binding: { ...binding, admissionId: command.userId } }) },
    { ...input({ ...observedOutsideInbox, binding: { ...binding, messageRefId: command.userId } }) },
    { ...input({ ...unavailable, code: 'invalid_command' } as never) },
  ])('rejects malformed or cross-bound input before DB work: %o', async (submitted) => {
    await expect(gmailArchiveReconciliationRepository.reconcile(submitted as never)).resolves.toEqual({
      ok: false,
      error: 'invalid_input',
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects accessors, symbols, non-enumerable properties, and revoked proxies without invoking them', async () => {
    const getter = vi.fn(() => command);
    const outer = { ...input() } as Record<string, unknown>;
    Object.defineProperty(outer, 'command', { enumerable: true, get: getter });
    const symbolEvidence = { ...observedOutsideInbox };
    Object.defineProperty(symbolEvidence, Symbol('secret'), { enumerable: true, value: 'hidden' });
    const nonEnumerableBinding = { ...binding };
    Object.defineProperty(nonEnumerableBinding, 'userId', {
      enumerable: false,
      value: binding.userId,
    });
    const revoked = Proxy.revocable(input(), {});
    revoked.revoke();
    for (const submitted of [
      outer,
      input(symbolEvidence),
      input({ ...observedOutsideInbox, binding: nonEnumerableBinding }),
      revoked.proxy,
    ]) {
      await expect(gmailArchiveReconciliationRepository.reconcile(submitted as never)).resolves.toEqual({
        ok: false,
        error: 'invalid_input',
      });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('enforces the recovery evidence-to-attempt phase matrix', () => {
    expect(gmailArchiveReconciliationEvidenceAllowedForPhase(
      interrupted,
      'pre_dispatch',
    )).toBe(true);
    expect(gmailArchiveReconciliationEvidenceAllowedForPhase(
      interrupted,
      'dispatch_may_have_started',
    )).toBe(false);
    for (const evidence of [observedOutsideInbox, observedInInbox, unavailable]) {
      expect(gmailArchiveReconciliationEvidenceAllowedForPhase(
        evidence,
        'pre_dispatch',
      )).toBe(false);
      expect(gmailArchiveReconciliationEvidenceAllowedForPhase(
        evidence,
        'dispatch_may_have_started',
      )).toBe(true);
    }
  });

  it.each([observedOutsideInbox, observedInInbox, unavailable])(
    'keeps every dispatch-started evidence case causal-unknown: $kind',
    (evidence) => {
      const envelope = buildGmailArchiveReconciliationTerminalEnvelope(envelopeInput(evidence));
      expect(envelope).toMatchObject({
        schema: 'gmail_archive_reconciliation_terminal_v1',
        attemptPhase: 'dispatch_may_have_started',
        outcome: 'unknown',
        code: 'recovery_causal_outcome_unknown',
        compensationAvailable: false,
      });
      expect(envelope).not.toHaveProperty('effect');
      expect(envelope).not.toHaveProperty('success');
      expect(envelope).not.toHaveProperty('leaseToken');
      expect(envelope).not.toHaveProperty('generation');
      expect(envelope).not.toHaveProperty('observationAttemptId');
      expect(parseGmailArchiveReconciliationTerminalEnvelope(envelope)).toEqual(envelope);
      expect(parseGmailArchiveReconciliationExplanationEvidence([envelope])).toEqual(envelope);
    },
  );

  it('records pre-dispatch interruption as a distinct known no-request failure', () => {
    const envelope = buildGmailArchiveReconciliationTerminalEnvelope({
      phase: 'pre_dispatch',
      phaseChangedAt,
      evidence: interrupted,
    });
    expect(envelope).toEqual({
      schema: 'gmail_archive_reconciliation_terminal_v1',
      attemptPhase: 'pre_dispatch',
      phaseChangedAt,
      outcome: 'failed',
      code: 'recovery_interrupted_before_dispatch',
      compensationAvailable: false,
      evidence: interrupted,
    });
    expect(gmailArchiveReconciliationExplanationSemantics(envelope).whatHappened)
      .toContain('before any Gmail mutation request began');
  });

  it('describes an observation as state at its observation time, not timeless current state', () => {
    const semantics = gmailArchiveReconciliationExplanationSemantics(
      buildGmailArchiveReconciliationTerminalEnvelope(envelopeInput(observedOutsideInbox)),
    );
    expect(semantics.confidenceReasoning).toContain('mailbox state at the observation time');
    expect(semantics.confidenceReasoning).not.toContain('establish current state');
  });

  it('rejects tampered envelopes and non-exact explanation arrays', () => {
    const envelope = buildGmailArchiveReconciliationTerminalEnvelope(envelopeInput());
    for (const value of [
      { ...envelope, extra: true },
      { ...envelope, outcome: 'succeeded' },
      { ...envelope, code: 'remote_outcome_unknown' },
      { ...envelope, evidence: interrupted },
      { ...envelope, phaseChangedAt: 'invalid' },
      {
        ...envelope,
        evidence: { ...observedOutsideInbox, observedAt: '2026-09-12T11:49:59.999Z' },
      },
    ]) expect(parseGmailArchiveReconciliationTerminalEnvelope(value)).toBeNull();
    expect(parseGmailArchiveReconciliationExplanationEvidence([])).toBeNull();
    expect(parseGmailArchiveReconciliationExplanationEvidence([envelope, envelope])).toBeNull();
  });

  it('snapshots nested authority evidence and reuses IDs and DB time across 40001 retries', async () => {
    withTransactionMock.mockImplementation(async (callback) => callback({}));
    const observations: unknown[] = [];
    let attempt = 0;
    const submitted = input({
      ...observedOutsideInbox,
      binding: { ...binding },
    });
    const pending = gmailArchiveReconciliationTestHooks.reconcileWithTransition(
      submitted,
      async (_client, snapshot, stableSnapshot) => {
        observations.push({ snapshot, stableSnapshot });
        attempt += 1;
        if (attempt < 3) throw Object.assign(new Error('restart'), { code: '40001' });
        return { ok: false, error: 'not_ready' };
      },
      () => stable,
    );
    submitted.command = { ...command, messageRefId: stable.resultId };
    submitted.recovery = {
      ...recovery,
      fence: { ...recovery.fence, leaseToken: stable.resultId },
    };
    if (submitted.evidence.kind !== 'mailbox_observed') throw new Error('test setup');
    (submitted.evidence.binding as { userId: string }).userId = stable.resultId;
    await expect(pending).resolves.toEqual({ ok: false, error: 'not_ready' });
    expect(withTransactionMock).toHaveBeenCalledTimes(3);
    expect(observations[0]).toEqual(observations[1]);
    expect(observations[1]).toEqual(observations[2]);
    const first = observations[0] as {
      snapshot: ReturnType<typeof input>;
      stableSnapshot: typeof stable;
    };
    expect(first.snapshot).toEqual(input());
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.command)).toBe(true);
    expect(Object.isFrozen(first.snapshot.recovery)).toBe(true);
    expect(Object.isFrozen(first.snapshot.recovery.fence)).toBe(true);
    expect(Object.isFrozen(first.snapshot.evidence)).toBe(true);
    if (first.snapshot.evidence.kind !== 'mailbox_observed') throw new Error('test setup');
    expect(Object.isFrozen(first.snapshot.evidence.binding)).toBe(true);
    expect(first.stableSnapshot).toEqual(stable);
    expect(Object.isFrozen(first.stableSnapshot)).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith('SELECT now() AS persisted_at');
  });

  it.each(['08006', '40003'])('maps ambiguous %s commits and does not retry them', async (code) => {
    withTransactionMock.mockImplementation(async (callback) => callback({}));
    await expect(gmailArchiveReconciliationTestHooks.reconcileWithTransition(
      input(unavailable),
      async () => {
        throw Object.assign(new Error('connection'), { code });
      },
      () => stable,
    )).resolves.toEqual({ ok: false, error: 'commit_unverified' });
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('exhausts 40001 retries without treating a serialization failure as commit ambiguity', async () => {
    withTransactionMock.mockImplementation(async (callback) => callback({}));
    const error = Object.assign(new Error('restart exhausted'), { code: '40001' });
    await expect(gmailArchiveReconciliationTestHooks.reconcileWithTransition(
      input(unavailable),
      async () => { throw error; },
      () => stable,
    )).rejects.toBe(error);
    expect(withTransactionMock).toHaveBeenCalledTimes(3);
  });

  it('does not mask an ordinary database failure as commit ambiguity', async () => {
    withTransactionMock.mockImplementation(async (callback) => callback({}));
    const error = Object.assign(new Error('constraint'), { code: '23514' });
    await expect(gmailArchiveReconciliationTestHooks.reconcileWithTransition(
      input(unavailable),
      async () => { throw error; },
      () => stable,
    )).rejects.toBe(error);
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('rejects observations outside the phase-to-persistence window', async () => {
    await expect(gmailArchiveReconciliationTestHooks.reconcileWithTransition(
      input({ ...observedOutsideInbox, observedAt: '2026-09-12T12:00:02.000Z' }),
      async () => ({ ok: false, error: 'not_ready' }),
      () => stable,
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(withTransactionMock).not.toHaveBeenCalled();

    await expect(gmailArchiveReconciliationTestHooks.reconcileWithTransition(
      input({ ...observedOutsideInbox, observedAt: '2026-09-12T11:40:00.000Z' }),
      async () => ({ ok: false, error: 'not_ready' }),
      () => stable,
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('does not allocate a terminal graph before the stable DB time clears grace', async () => {
    await expect(gmailArchiveReconciliationTestHooks.reconcileWithTransition(
      input(unavailable),
      async () => ({ ok: false, error: 'idempotency_conflict' }),
      () => ({ ...stable, persistedAt: '2026-09-12T11:54:59.999Z' }),
      async () => '2026-09-12T11:54:59.999Z',
    )).resolves.toEqual({ ok: false, error: 'not_ready' });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('is structurally incompatible with mutation and observation commands', () => {
    expect(command.operation).not.toBe('archive');
    expect(command.operation).not.toBe('observe_inbox');
    expect(Object.keys(command).sort()).toEqual([
      'admissionId', 'messageRefId', 'operation', 'userId',
    ]);
    expect(Object.keys(input()).sort()).toEqual(['command', 'evidence', 'recovery']);
  });

  it('contains no provider, credential, observation, gate, router, API, worker, or network call', async () => {
    const source = await readFile(
      new URL('../repositories/gmail-archive-reconciliation-repository.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/@skytwin\/(?:connectors|credential-vault|execution-router|ironclaw-adapter)/);
    expect(source).not.toMatch(/gmail-inbox-observation|dispatch-gate|apps\/(?:api|worker)/);
    expect(source).not.toMatch(/\bfetch\s*\(|https?:\/\/|\/modify\b|\bPOST\b/);
    expect(source).not.toMatch(/INSERT INTO execution_events/);
    expect(source).toContain("AND updated_at = $13::TIMESTAMPTZ");
    const claim = await readFile(
      new URL('../repositories/gmail-archive-claim-repository.ts', import.meta.url),
      'utf8',
    );
    const gate = await readFile(
      new URL('../repositories/gmail-archive-dispatch-gate-repository.ts', import.meta.url),
      'utf8',
    );
    expect(claim).toContain("updated_at = date_trunc('milliseconds', now())");
    expect(gate).toContain("updated_at = date_trunc('milliseconds', now())");
  });

  it('is not constructed by API, worker, or execution-router runtime code', async () => {
    const roots = [
      new URL('../../../../apps/api/', import.meta.url),
      new URL('../../../../apps/worker/', import.meta.url),
      new URL('../../../../apps/desktop/', import.meta.url),
      new URL('../../../execution-router/', import.meta.url),
      new URL('../../../ironclaw-adapter/', import.meta.url),
    ];
    const runtimeSources = (await Promise.all(roots.map(sourceFilesBelow))).flat().join('\n');
    expect(runtimeSources).not.toContain('gmailArchiveReconciliationRepository');
    expect(runtimeSources).not.toContain('ReconcileAbandonedGmailArchiveInput');
  });
});
