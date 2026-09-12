import { readFile, readdir } from 'node:fs/promises';
import type {
  GmailArchiveRecoveryLeaseFence,
  GmailInboxMutationResult,
  RecordGmailArchiveRecoveryObservationInput,
} from '@skytwin/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolveTargetMock,
  refreshIfExpiredMock,
  dispatchGateEnterMock,
} = vi.hoisted(() => ({
  resolveTargetMock: vi.fn(),
  refreshIfExpiredMock: vi.fn(),
  dispatchGateEnterMock: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA: 'gmail_inbox_mutation_v1',
  GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS: 150,
  gmailInboxObservationTargetRepository: {},
  gmailMessageRefRepository: { resolveInboxMutationTarget: resolveTargetMock },
  oauthRepository: {},
}));

vi.mock('@skytwin/connectors', () => ({
  DbTokenStore: class {
    refreshIfExpiredWithRevision(...args: unknown[]) {
      return refreshIfExpiredMock(...args);
    }
  },
}));

const { GmailArchiveCallerKernel } = await import('../gmail-archive-caller-kernel.js');
const { GmailInboxMutationService } = await import('../gmail-inbox-mutation-port.js');
const { GmailArchiveRecoveryObservationCoordinator } =
  await import('../gmail-inbox-observation-port.js');

const authority = {
  userId: '11111111-1111-4111-8111-111111111111',
  approvalId: '22222222-2222-4222-8222-222222222222',
};
const command = {
  userId: authority.userId,
  admissionId: '33333333-3333-4333-8333-333333333333',
  messageRefId: '44444444-4444-4444-8444-444444444444',
  operation: 'archive' as const,
};
const binding = {
  userId: command.userId,
  admissionId: command.admissionId,
  messageRefId: command.messageRefId,
};
const fence: GmailArchiveRecoveryLeaseFence = {
  ...authority,
  admissionId: command.admissionId,
  messageRefId: command.messageRefId,
  workKind: 'observe_dispatch',
  barrierStatus: 'in_progress',
  attemptPhase: 'dispatch_may_have_started',
  phaseChangedAt: '2026-09-12T12:00:00.123456Z',
  leaseToken: '55555555-5555-4555-8555-555555555555',
  generation: 7,
};
const terminal = {
  disposition: 'succeeded' as const,
  receiptRevisionId: '66666666-6666-4666-8666-666666666666',
  recordedAt: '2026-09-12T12:01:00.123Z',
};
const confirmed: GmailInboxMutationResult = {
  outcome: 'confirmed',
  operation: 'archive',
  inbox: false,
  effect: 'changed',
  compensationAvailable: false,
  observedAt: '2026-09-12T12:00:30.123Z',
  binding,
};

function dependencySet(overrides: Record<string, unknown> = {}) {
  const calls = {
    claim: vi.fn().mockResolvedValue({ ok: true, claimed: true, command }),
    mutate: vi.fn().mockResolvedValue(confirmed),
    terminalize: vi.fn().mockResolvedValue({ ok: true, created: true, terminalization: {} }),
    observe: vi.fn().mockResolvedValue({ status: 'evidence_recorded', evidence: { secret: true } }),
    reconcile: vi.fn().mockResolvedValue({ ok: true, reconciled: true }),
    read: vi.fn().mockResolvedValue({ ok: true, status: 'terminal', terminal }),
    ...overrides,
  };
  const kernel = new GmailArchiveCallerKernel({
    claimRepository: { claim: calls.claim },
    mutation: { mutate: calls.mutate },
    terminalizationRepository: { terminalize: calls.terminalize },
    observation: { observe: calls.observe },
    recordedObservationReconciler: { reconcileRecordedObservation: calls.reconcile },
    terminalStatusReader: { read: calls.read },
  } as never);
  return { calls, kernel };
}

function notTerminal() {
  return { ok: true, status: 'not_terminal', terminal: null } as const;
}

async function sourceFilesBelow(
  directory: URL,
  excludedFiles: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory() && ['__tests__', 'dist', 'node_modules'].includes(entry.name)) return [];
    if (!entry.isDirectory() && excludedFiles.has(entry.name)) return [];
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) return sourceFilesBelow(child, excludedFiles);
    return entry.name.endsWith('.ts') ? [await readFile(child, 'utf8')] : [];
  }));
  return nested.flat();
}

describe('GmailArchiveCallerKernel', () => {
  beforeEach(() => {
    resolveTargetMock.mockReset();
    refreshIfExpiredMock.mockReset();
    dispatchGateEnterMock.mockReset();
  });

  it('claims, mutates, terminalizes, and reads terminal truth exactly once in order', async () => {
    const order: string[] = [];
    const { calls, kernel } = dependencySet({
      claim: vi.fn(async () => {
        order.push('claim');
        return { ok: true, claimed: true, command };
      }),
      mutate: vi.fn(async () => {
        order.push('mutation');
        return confirmed;
      }),
      terminalize: vi.fn(async () => {
        order.push('terminalization');
        return { ok: true, created: true, terminalization: {} };
      }),
      read: vi.fn(async () => {
        order.push('terminal_status');
        return { ok: true, status: 'terminal', terminal };
      }),
    });
    const result = await kernel.executeApproved(authority);
    expect(result).toEqual({ ok: true, status: 'terminal', terminal });
    expect(order).toEqual(['claim', 'mutation', 'terminalization', 'terminal_status']);
    expect(calls.claim).toHaveBeenCalledTimes(1);
    expect(calls.mutate).toHaveBeenCalledTimes(1);
    expect(calls.terminalize).toHaveBeenCalledTimes(1);
    expect(calls.read).toHaveBeenCalledTimes(1);
    expect(calls.observe).not.toHaveBeenCalled();
    expect(calls.reconcile).not.toHaveBeenCalled();
    expect(Object.isFrozen(calls.mutate.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(calls.terminalize.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(calls.terminalize.mock.calls[0]?.[0].result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok && result.status === 'terminal') expect(Object.isFrozen(result.terminal)).toBe(true);
  });

  it.each([
    { name: 'changed', result: confirmed },
    { name: 'already in state', result: { ...confirmed, effect: 'already_in_state' as const } },
    { name: 'reconciled', result: { ...confirmed, effect: 'reconciled' as const } },
    ...[
      'not_admitted', 'admission_unavailable', 'credentials_unavailable',
      'preflight_unavailable', 'remote_rejected',
    ].map((code) => ({ name: code, result: {
      outcome: 'known_failure' as const, code,
      compensationAvailable: false as const, binding,
    } })),
    { name: 'unknown', result: {
      outcome: 'unknown' as const,
      code: 'remote_outcome_unknown' as const,
      compensationAvailable: false as const,
      binding,
    } },
  ])('terminalizes an exact frozen command/result snapshot for $name', async ({ result }) => {
    const { calls, kernel } = dependencySet({ mutate: vi.fn().mockResolvedValue(result) });
    await expect(kernel.executeApproved(authority)).resolves.toMatchObject({
      ok: true,
      status: 'terminal',
    });
    expect(calls.mutate).toHaveBeenCalledTimes(1);
    expect(calls.terminalize).toHaveBeenCalledTimes(1);
    const submitted = calls.terminalize.mock.calls[0]?.[0];
    expect(submitted).toEqual({ command, result });
    expect(Object.isFrozen(submitted)).toBe(true);
    expect(Object.isFrozen(submitted.command)).toBe(true);
    expect(Object.isFrozen(submitted.result)).toBe(true);
    if ('binding' in submitted.result) expect(Object.isFrozen(submitted.result.binding)).toBe(true);
  });

  it.each(['blocked', 'succeeded', 'failed', 'unknown'] as const)(
    'passes through only reader-validated %s terminal status',
    async (disposition) => {
      const visible = { ...terminal, disposition };
      const { kernel } = dependencySet({
        read: vi.fn().mockResolvedValue({ ok: true, status: 'terminal', terminal: visible }),
      });
      await expect(kernel.executeApproved(authority)).resolves.toEqual({
        ok: true,
        status: 'terminal',
        terminal: visible,
      });
    },
  );

  it('handles every non-claim state without invoking mutation', async () => {
    for (const [claim, expected, reads] of [
      [
        { ok: true, claimed: false, state: 'not_ready', command: null },
        { ok: true, status: 'not_started', reason: 'not_ready' },
        0,
      ],
      [
        { ok: true, claimed: false, state: 'in_progress', command: null },
        { ok: true, status: 'not_started', reason: 'in_progress' },
        0,
      ],
      [
        { ok: true, claimed: false, state: 'terminal', command: null },
        { ok: true, status: 'terminal', terminal },
        1,
      ],
    ] as const) {
      const { calls, kernel } = dependencySet({ claim: vi.fn().mockResolvedValue(claim) });
      await expect(kernel.executeApproved(authority)).resolves.toEqual(expected);
      expect(calls.mutate).not.toHaveBeenCalled();
      expect(calls.terminalize).not.toHaveBeenCalled();
      expect(calls.read).toHaveBeenCalledTimes(reads);
    }
  });

  it.each(['invalid_input', 'not_found', 'policy_stale', 'idempotency_conflict'] as const)(
    'maps exact claim rejection %s without invoking mutation',
    async (code) => {
      const { calls, kernel } = dependencySet({
        claim: vi.fn().mockResolvedValue({ ok: false, error: code }),
      });
      await expect(kernel.executeApproved(authority)).resolves.toEqual({
        ok: false,
        error: 'claim_rejected',
        code,
      });
      expect(calls.mutate).not.toHaveBeenCalled();
      expect(calls.read).not.toHaveBeenCalled();
    },
  );

  it('fails closed on a thrown claim without mutation or status work', async () => {
    const { calls, kernel } = dependencySet({
      claim: vi.fn().mockRejectedValue(new Error('claim reply unavailable')),
    });
    await expect(kernel.executeApproved(authority)).resolves.toEqual({
      ok: false,
      error: 'unverified',
      stage: 'claim',
    });
    expect(calls.mutate).not.toHaveBeenCalled();
    expect(calls.terminalize).not.toHaveBeenCalled();
    expect(calls.read).not.toHaveBeenCalled();
  });

  it('rejects malformed authority before claim without invoking getters', async () => {
    const getter = vi.fn(() => authority.userId);
    const accessor = { ...authority } as Record<string, unknown>;
    Object.defineProperty(accessor, 'userId', { enumerable: true, get: getter });
    const symbol = { ...authority };
    Object.defineProperty(symbol, Symbol('authority'), { enumerable: true, value: true });
    const revoked = Proxy.revocable({ ...authority }, {});
    revoked.revoke();
    for (const submitted of [
      null,
      {},
      { ...authority, extra: true },
      { ...authority, userId: 'invalid' },
      { ...authority, approvalId: 'invalid' },
      Object.assign(Object.create({}), authority),
      accessor,
      symbol,
      revoked.proxy,
    ]) {
      const { calls, kernel } = dependencySet();
      await expect(kernel.executeApproved(submitted as never)).resolves.toEqual({
        ok: false,
        error: 'invalid_input',
        stage: 'claim',
      });
      expect(calls.claim).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects malformed claims and mutation evidence without terminalizing', async () => {
    const mismatchedBinding = { ...binding, admissionId: fence.leaseToken };
    const revoked = Proxy.revocable({ ...confirmed }, {});
    revoked.revoke();
    const cases = [
      { claim: { ok: true, claimed: true, command: { ...command, extra: true } } },
      { claim: { ok: true, claimed: true, command: { ...command, userId: fence.leaseToken } } },
      { claim: { ok: true, claimed: true, command: null } },
      { claim: { ok: true, claimed: true, command }, mutation: {
        outcome: 'known_failure', code: 'invalid_command', compensationAvailable: false,
      } },
      { claim: { ok: true, claimed: true, command }, mutation: { ...confirmed, binding: mismatchedBinding } },
      { claim: { ok: true, claimed: true, command }, mutation: { ...confirmed, extra: true } },
      { claim: { ok: true, claimed: true, command }, mutation: { ...confirmed, observedAt: 'invalid' } },
      { claim: { ok: true, claimed: true, command }, mutation: revoked.proxy },
    ];
    for (const testCase of cases) {
      const { calls, kernel } = dependencySet({
        claim: vi.fn().mockResolvedValue(testCase.claim),
        mutate: vi.fn().mockResolvedValue(testCase.mutation ?? confirmed),
      });
      await expect(kernel.executeApproved(authority)).resolves.toMatchObject({
        ok: false,
        error: 'unverified',
      });
      expect(calls.terminalize).not.toHaveBeenCalled();
      expect(calls.read).not.toHaveBeenCalled();
      expect(calls.mutate.mock.calls.length).toBeLessThanOrEqual(1);
    }
  });

  it('does not invoke accessors on a hostile mutation result', async () => {
    const getter = vi.fn(() => confirmed.observedAt);
    const result = { ...confirmed } as Record<string, unknown>;
    Object.defineProperty(result, 'observedAt', { enumerable: true, get: getter });
    const { calls, kernel } = dependencySet({ mutate: vi.fn().mockResolvedValue(result) });
    await expect(kernel.executeApproved(authority)).resolves.toEqual({
      ok: false,
      error: 'unverified',
      stage: 'mutation',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(calls.terminalize).not.toHaveBeenCalled();
  });

  it('does not turn thrown mutation work into fabricated terminal evidence', async () => {
    const { calls, kernel } = dependencySet({
      mutate: vi.fn().mockRejectedValue(new Error('uncertain')),
    });
    await expect(kernel.executeApproved(authority)).resolves.toEqual({
      ok: false,
      error: 'unverified',
      stage: 'mutation',
    });
    expect(calls.terminalize).not.toHaveBeenCalled();
    expect(calls.read).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_input', 'terminalization_rejected'],
    ['not_found', 'terminalization_rejected'],
    ['not_ready', 'terminalization_rejected'],
    ['idempotency_conflict', 'terminalization_rejected'],
    ['integrity_conflict', 'terminalization_rejected'],
    ['commit_unverified', 'unverified'],
  ] as const)('reads status once after terminalization %s', async (code, error) => {
    const { calls, kernel } = dependencySet({
      terminalize: vi.fn().mockResolvedValue({ ok: false, error: code }),
      read: vi.fn().mockResolvedValue(notTerminal()),
    });
    const result = await kernel.executeApproved(authority);
    expect(result).toMatchObject(error === 'terminalization_rejected'
      ? { ok: false, error, code }
      : { ok: false, error, stage: 'terminalization' });
    expect(calls.mutate).toHaveBeenCalledTimes(1);
    expect(calls.terminalize).toHaveBeenCalledTimes(1);
    expect(calls.read).toHaveBeenCalledTimes(1);
  });

  it('lets independently validated status win after terminalization uncertainty', async () => {
    for (const terminalize of [
      vi.fn().mockRejectedValue(new Error('lost reply')),
      vi.fn().mockResolvedValue({ ok: false, error: 'commit_unverified' }),
      vi.fn().mockResolvedValue({ malformed: true }),
      vi.fn().mockResolvedValue({ ok: true, created: false, terminalization: {} }),
    ]) {
      const { calls, kernel } = dependencySet({ terminalize });
      await expect(kernel.executeApproved(authority)).resolves.toEqual({
        ok: true,
        status: 'terminal',
        terminal,
      });
      expect(calls.mutate).toHaveBeenCalledTimes(1);
      expect(calls.terminalize).toHaveBeenCalledTimes(1);
      expect(calls.read).toHaveBeenCalledTimes(1);
    }
  });

  it('maps malformed terminalization without persisted status to terminalization uncertainty', async () => {
    const { calls, kernel } = dependencySet({
      terminalize: vi.fn().mockResolvedValue({ ok: true, created: true, terminalization: null }),
      read: vi.fn().mockResolvedValue(notTerminal()),
    });
    await expect(kernel.executeApproved(authority)).resolves.toEqual({
      ok: false,
      error: 'unverified',
      stage: 'terminalization',
    });
    expect(calls.mutate).toHaveBeenCalledTimes(1);
    expect(calls.terminalize).toHaveBeenCalledTimes(1);
    expect(calls.read).toHaveBeenCalledTimes(1);
  });

  it('treats malformed or failed terminal-status results as unverified', async () => {
    for (const read of [
      vi.fn().mockRejectedValue(new Error('read failed')),
      vi.fn().mockResolvedValue({ ok: false, error: 'integrity_conflict' }),
      vi.fn().mockResolvedValue({ ok: true, status: 'terminal', terminal: { ...terminal, extra: true } }),
      vi.fn().mockResolvedValue({ ok: true, status: 'terminal', terminal: {
        ...terminal, recordedAt: '2026-09-12T12:01:00.123456Z',
      } }),
    ]) {
      const { kernel } = dependencySet({ read });
      await expect(kernel.executeApproved(authority)).resolves.toEqual({
        ok: false,
        error: 'unverified',
        stage: 'terminal_status',
      });
    }
  });

  it('snapshots authority and command before caller mutation can cross an await', async () => {
    let resolveClaim!: (value: unknown) => void;
    const claim = vi.fn(() => new Promise((resolve) => { resolveClaim = resolve; }));
    const submitted = { ...authority };
    const { calls, kernel } = dependencySet({ claim });
    const pending = kernel.executeApproved(submitted);
    submitted.userId = fence.leaseToken;
    resolveClaim({ ok: true, claimed: true, command });
    await pending;
    expect(calls.claim).toHaveBeenCalledWith(authority);
    expect(Object.isFrozen(calls.claim.mock.calls[0]?.[0])).toBe(true);
    expect(calls.mutate).toHaveBeenCalledWith(command);
  });

  it('runs observation, durable reconciliation, and status exactly once in order', async () => {
    for (const observation of [
      { status: 'not_permitted' },
      { status: 'evidence_recorded', evidence: { capability: 'must-not-flow' } },
      { status: 'evidence_unverified', evidence: { capability: 'must-not-flow' } },
      new Error('coordinator failed'),
    ]) {
      const order: string[] = [];
      const observe = observation instanceof Error
        ? vi.fn(async () => { order.push('observation'); throw observation; })
        : vi.fn(async () => { order.push('observation'); return observation; });
      const reconcile = vi.fn(async () => {
        order.push('reconciliation');
        return { ok: true, reconciled: true };
      });
      const read = vi.fn(async () => {
        order.push('terminal_status');
        return { ok: true, status: 'terminal', terminal };
      });
      const { calls, kernel } = dependencySet({ observe, reconcile, read });
      await expect(kernel.reconcileObserved(fence)).resolves.toEqual({
        ok: true,
        status: 'terminal',
        terminal,
      });
      expect(order).toEqual(['observation', 'reconciliation', 'terminal_status']);
      expect(calls.observe).toHaveBeenCalledTimes(1);
      expect(calls.reconcile).toHaveBeenCalledTimes(1);
      expect(calls.reconcile).toHaveBeenCalledWith(fence);
      expect(calls.read).toHaveBeenCalledTimes(1);
      expect(calls.claim).not.toHaveBeenCalled();
      expect(calls.mutate).not.toHaveBeenCalled();
    }
  });

  it.each([
    'invalid_input', 'not_found', 'not_ready', 'stale_lease',
    'integrity_conflict', 'idempotency_conflict',
  ] as const)('returns exact reconciliation rejection %s when status is not terminal', async (code) => {
    const { calls, kernel } = dependencySet({
      reconcile: vi.fn().mockResolvedValue({ ok: false, error: code }),
      read: vi.fn().mockResolvedValue(notTerminal()),
    });
    await expect(kernel.reconcileObserved(fence)).resolves.toEqual({
      ok: false,
      error: 'reconciliation_rejected',
      code,
    });
    expect(calls.observe).toHaveBeenCalledTimes(1);
    expect(calls.reconcile).toHaveBeenCalledTimes(1);
    expect(calls.read).toHaveBeenCalledTimes(1);
  });

  it('reads status after reconciliation throw, ambiguity, success, or malformed return', async () => {
    for (const reconcile of [
      vi.fn().mockRejectedValue(new Error('lost reply')),
      vi.fn().mockResolvedValue({ ok: false, error: 'commit_unverified' }),
      vi.fn().mockResolvedValue({ malformed: true }),
      vi.fn().mockResolvedValue({ ok: true, reconciled: true }),
      vi.fn().mockResolvedValue({ ok: true, reconciled: false, state: 'reconciliation_replay' }),
    ]) {
      const { calls, kernel } = dependencySet({ reconcile });
      await expect(kernel.reconcileObserved(fence)).resolves.toEqual({
        ok: true,
        status: 'terminal',
        terminal,
      });
      expect(calls.observe).toHaveBeenCalledTimes(1);
      expect(calls.reconcile).toHaveBeenCalledTimes(1);
      expect(calls.read).toHaveBeenCalledTimes(1);
    }
  });

  it('fails closed on recovery terminal-status failure or malformed truth', async () => {
    for (const read of [
      vi.fn().mockRejectedValue(new Error('reader unavailable')),
      vi.fn().mockResolvedValue({ ok: false, error: 'not_found' }),
      vi.fn().mockResolvedValue({ ok: true, status: 'terminal', terminal: { ...terminal, extra: true } }),
      vi.fn().mockResolvedValue({ ok: true, status: 'unexpected', terminal: null }),
    ]) {
      const { calls, kernel } = dependencySet({ read });
      await expect(kernel.reconcileObserved(fence)).resolves.toEqual({
        ok: false,
        error: 'unverified',
        stage: 'terminal_status',
      });
      expect(calls.observe).toHaveBeenCalledTimes(1);
      expect(calls.reconcile).toHaveBeenCalledTimes(1);
      expect(calls.read).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    { name: 'new reconciliation', result: { ok: true, reconciled: true } },
    { name: 'reconciliation replay', result: {
      ok: true, reconciled: false, state: 'reconciliation_replay',
    } },
    { name: 'ordinary terminal', result: {
      ok: true, reconciled: false, state: 'already_terminal',
    } },
    { name: 'minimal terminal', result: { ok: true, reconciled: false, state: 'terminal' } },
  ] as const)('does not treat $name control as visible terminal truth', async ({ result }) => {
    const { calls, kernel } = dependencySet({
      reconcile: vi.fn().mockResolvedValue(result),
      read: vi.fn().mockResolvedValue(notTerminal()),
    });
    await expect(kernel.reconcileObserved(fence)).resolves.toEqual({
      ok: false,
      error: 'unverified',
      stage: 'reconciliation',
    });
    expect(calls.observe).toHaveBeenCalledTimes(1);
    expect(calls.reconcile).toHaveBeenCalledTimes(1);
    expect(calls.read).toHaveBeenCalledTimes(1);
  });

  it('rejects every invalid recovery fence field before observation', async () => {
    const invalidByField: Record<keyof GmailArchiveRecoveryLeaseFence, unknown> = {
      userId: 'invalid',
      approvalId: 'invalid',
      admissionId: 'invalid',
      messageRefId: 'invalid',
      workKind: 'resume_claim',
      barrierStatus: 'prepared',
      attemptPhase: 'pre_dispatch',
      phaseChangedAt: 'invalid',
      leaseToken: 'invalid',
      generation: 0,
    };
    for (const field of Object.keys(invalidByField) as Array<keyof typeof invalidByField>) {
      const { calls, kernel } = dependencySet();
      await expect(kernel.reconcileObserved({
        ...fence,
        [field]: invalidByField[field],
      } as never)).resolves.toEqual({
        ok: false,
        error: 'invalid_input',
        stage: 'observation',
      });
      expect(calls.observe).not.toHaveBeenCalled();
      expect(calls.reconcile).not.toHaveBeenCalled();
      expect(calls.read).not.toHaveBeenCalled();
    }
  });

  it('rejects hostile recovery fences without invoking getters', async () => {
    const getter = vi.fn(() => fence.leaseToken);
    const accessor = { ...fence } as Record<string, unknown>;
    Object.defineProperty(accessor, 'leaseToken', { enumerable: true, get: getter });
    const revoked = Proxy.revocable({ ...fence }, {});
    revoked.revoke();
    for (const submitted of [
      { ...fence, extra: true },
      Object.assign(Object.create({}), fence),
      accessor,
      revoked.proxy,
    ]) {
      const { calls, kernel } = dependencySet();
      await expect(kernel.reconcileObserved(submitted as never)).resolves.toEqual({
        ok: false,
        error: 'invalid_input',
        stage: 'observation',
      });
      expect(calls.observe).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('freezes the recovery fence before observation and ignores caller mutation', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const submitted = { ...fence };
    const { calls, kernel } = dependencySet({ observe: vi.fn(() => paused) });
    const pending = kernel.reconcileObserved(submitted);
    submitted.generation = 99;
    release();
    await pending;
    expect(calls.observe).toHaveBeenCalledWith(fence);
    expect(calls.reconcile).toHaveBeenCalledWith(fence);
    expect(Object.isFrozen(calls.observe.mock.calls[0]?.[0])).toBe(true);
  });

  it('snapshots every authority and fence field before caller mutation', async () => {
    const authorityReplacements = {
      userId: fence.leaseToken,
      approvalId: terminal.receiptRevisionId,
    };
    for (const field of Object.keys(authorityReplacements) as Array<keyof typeof authority>) {
      let resolveClaim!: (value: unknown) => void;
      const submitted = { ...authority };
      const { calls, kernel } = dependencySet({
        claim: vi.fn(() => new Promise((resolve) => { resolveClaim = resolve; })),
      });
      const pending = kernel.executeApproved(submitted);
      submitted[field] = authorityReplacements[field];
      resolveClaim({ ok: true, claimed: false, state: 'not_ready', command: null });
      await pending;
      expect(calls.claim).toHaveBeenCalledWith(authority);
    }

    const fenceReplacements: Record<keyof GmailArchiveRecoveryLeaseFence, unknown> = {
      userId: fence.leaseToken,
      approvalId: terminal.receiptRevisionId,
      admissionId: fence.leaseToken,
      messageRefId: fence.leaseToken,
      workKind: 'resume_claim',
      barrierStatus: 'prepared',
      attemptPhase: 'pre_dispatch',
      phaseChangedAt: '2026-09-12T12:00:01.123456Z',
      leaseToken: terminal.receiptRevisionId,
      generation: 8,
    };
    for (const field of Object.keys(fenceReplacements) as Array<keyof typeof fence>) {
      let release!: () => void;
      const pause = new Promise<void>((resolve) => { release = resolve; });
      const submitted = { ...fence } as Record<string, unknown>;
      const { calls, kernel } = dependencySet({ observe: vi.fn(() => pause) });
      const pending = kernel.reconcileObserved(submitted as unknown as GmailArchiveRecoveryLeaseFence);
      submitted[field] = fenceReplacements[field];
      release();
      await pending;
      expect(calls.observe).toHaveBeenCalledWith(fence);
      expect(calls.reconcile).toHaveBeenCalledWith(fence);
    }
  });

  it('binds every injected method once against later option and method swaps', async () => {
    const original = dependencySet();
    const replacements = {
      claim: vi.fn(), mutate: vi.fn(), terminalize: vi.fn(),
      observe: vi.fn(), reconcile: vi.fn(), read: vi.fn(),
    };
    original.calls.claim.mockImplementation(original.calls.claim.getMockImplementation()!);
    const claimObject = { claim: original.calls.claim };
    const mutationObject = { mutate: original.calls.mutate };
    const terminalizationObject = { terminalize: original.calls.terminalize };
    const observationObject = { observe: original.calls.observe };
    const reconcileObject = { reconcileRecordedObservation: original.calls.reconcile };
    const readerObject = { read: original.calls.read };
    const options = {
      claimRepository: claimObject,
      mutation: mutationObject,
      terminalizationRepository: terminalizationObject,
      observation: observationObject,
      recordedObservationReconciler: reconcileObject,
      terminalStatusReader: readerObject,
    };
    const kernel = new GmailArchiveCallerKernel(options as never);
    claimObject.claim = replacements.claim;
    mutationObject.mutate = replacements.mutate;
    terminalizationObject.terminalize = replacements.terminalize;
    observationObject.observe = replacements.observe;
    reconcileObject.reconcileRecordedObservation = replacements.reconcile;
    readerObject.read = replacements.read;
    Object.assign(options, {
      claimRepository: { claim: replacements.claim },
      mutation: { mutate: replacements.mutate },
    });
    await kernel.executeApproved(authority);
    await kernel.reconcileObserved(fence);
    expect(original.calls.claim).toHaveBeenCalledTimes(1);
    expect(original.calls.mutate).toHaveBeenCalledTimes(1);
    expect(original.calls.terminalize).toHaveBeenCalledTimes(1);
    expect(original.calls.observe).toHaveBeenCalledTimes(1);
    expect(original.calls.reconcile).toHaveBeenCalledTimes(1);
    expect(original.calls.read).toHaveBeenCalledTimes(2);
    for (const replacement of Object.values(replacements)) expect(replacement).not.toHaveBeenCalled();
  });

  it('reads each injected object and method exactly once during construction', () => {
    const reads: Record<string, number> = {};
    const method = (name: string, implementation: (...args: unknown[]) => unknown) => {
      const port: Record<string, unknown> = {};
      Object.defineProperty(port, name, {
        enumerable: true,
        get() {
          reads[name] = (reads[name] ?? 0) + 1;
          return implementation;
        },
      });
      return port;
    };
    const ports = {
      claimRepository: method('claim', async () => ({ ok: false, error: 'not_found' })),
      mutation: method('mutate', async () => confirmed),
      terminalizationRepository: method('terminalize', async () => ({
        ok: true, created: true, terminalization: {},
      })),
      observation: method('observe', async () => ({ status: 'not_permitted' })),
      recordedObservationReconciler: method('reconcileRecordedObservation', async () => ({
        ok: false, error: 'not_ready',
      })),
      terminalStatusReader: method('read', async () => notTerminal()),
    };
    const optionReads: Record<string, number> = {};
    const options: Record<string, unknown> = {};
    for (const [name, port] of Object.entries(ports)) {
      Object.defineProperty(options, name, {
        enumerable: true,
        get() {
          optionReads[name] = (optionReads[name] ?? 0) + 1;
          return port;
        },
      });
    }
    expect(() => new GmailArchiveCallerKernel(options as never)).not.toThrow();
    expect(optionReads).toEqual(Object.fromEntries(Object.keys(ports).map((name) => [name, 1])));
    expect(reads).toEqual({
      claim: 1,
      mutate: 1,
      terminalize: 1,
      observe: 1,
      reconcileRecordedObservation: 1,
      read: 1,
    });
  });

  it('composes with the mutation service without adding a second gate or POST', async () => {
    const target = {
      connectorAccountId: '77777777-7777-4777-8777-777777777777',
      credentialRevision: '88888888-8888-4888-8888-888888888888',
      providerMessageId: 'provider-message',
    };
    resolveTargetMock.mockResolvedValue(target);
    refreshIfExpiredMock.mockResolvedValue({
      accessToken: 'secret-token',
      credentialRevision: target.credentialRevision,
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    });
    dispatchGateEnterMock.mockResolvedValue({ status: 'entered' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: target.providerMessageId,
        labelIds: ['INBOX'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: target.providerMessageId,
        labelIds: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const mutation = new GmailInboxMutationService({
      googleOAuthConfig: { clientId: 'client', clientSecret: '', redirectUri: 'http://localhost' },
      dispatchGate: { enter: dispatchGateEnterMock },
      fetch: fetchMock,
    });
    const { calls, kernel } = dependencySet({ mutate: mutation.mutate.bind(mutation) });
    await expect(kernel.executeApproved(authority)).resolves.toMatchObject({
      ok: true,
      status: 'terminal',
    });
    expect(dispatchGateEnterMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    expect(calls.terminalize).toHaveBeenCalledTimes(1);
  });

  it('re-entry through the real observation coordinator cannot authorize a second GET', async () => {
    const permit = {
      ...fence,
      observationAttemptId: '99999999-9999-4999-8999-999999999999',
      authorizedAt: '2026-09-12T12:00:01.123Z',
      leaseExpiresAt: '2026-09-12T12:05:00.123Z',
      deadlineAt: '2026-09-12T12:02:31.123Z',
    };
    const beginObservation = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 'permitted', permit })
      .mockResolvedValueOnce({ ok: true, status: 'evidence_recorded', permit: null });
    const recordObservation = vi.fn(async (input: RecordGmailArchiveRecoveryObservationInput) => ({
      ok: true as const,
      recorded: true,
      evidence: input.evidence,
    }));
    const observationFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'provider-message',
      labelIds: ['INBOX'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const selection = {
      connectorAccountId: '77777777-7777-4777-8777-777777777777',
      credentialRevision: '88888888-8888-4888-8888-888888888888',
      providerMessageId: 'provider-message',
    };
    const observation = new GmailArchiveRecoveryObservationCoordinator({
      leaseRepository: {
        acquire: vi.fn(),
        renew: vi.fn(),
        beginObservation,
        recordObservation,
      },
      credentials: { materialize: vi.fn().mockResolvedValue({
        accessToken: 'secret-token',
        credentialRevision: selection.credentialRevision,
        scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      }) },
      targetResolver: {
        resolveInitial: vi.fn().mockResolvedValue(selection),
        resolveFinal: vi.fn().mockResolvedValue(selection),
      },
      fetch: observationFetch,
    });
    const { calls, kernel } = dependencySet({ observe: observation.observe.bind(observation) });
    await expect(kernel.reconcileObserved(fence)).resolves.toMatchObject({
      ok: true,
      status: 'terminal',
    });
    await expect(kernel.reconcileObserved(fence)).resolves.toMatchObject({
      ok: true,
      status: 'terminal',
    });
    expect(beginObservation).toHaveBeenCalledTimes(2);
    expect(observationFetch).toHaveBeenCalledTimes(1);
    expect(recordObservation).toHaveBeenCalledTimes(1);
    expect(calls.reconcile).toHaveBeenCalledTimes(2);
    expect(calls.read).toHaveBeenCalledTimes(2);
  });

  it('remains leaf-only, unwired, and absent from runtime and package barrels', async () => {
    const source = await readFile(
      new URL('../gmail-archive-caller-kernel.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"]@skytwin\/(?:db|connectors|execution-router)/);
    expect(source).not.toContain('dispatchGate');
    const barrels = await Promise.all([
      readFile(new URL('../index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../db/src/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../db/src/repositories/index.ts', import.meta.url), 'utf8'),
    ]);
    for (const barrel of barrels) {
      expect(barrel).not.toContain('GmailArchiveCallerKernel');
      expect(barrel).not.toContain('gmail-archive-caller-kernel');
      expect(barrel).not.toContain('GmailArchiveCallerKernelOptions');
      expect(barrel).not.toContain('GmailArchiveCallerResult');
    }
    const roots = [
      new URL('../../../../apps/api/', import.meta.url),
      new URL('../../../../apps/worker/', import.meta.url),
      new URL('../../../../apps/desktop/', import.meta.url),
      new URL('../../../execution-router/', import.meta.url),
      new URL('../handlers/', import.meta.url),
    ];
    const runtime = (await Promise.all(roots.map((root) => sourceFilesBelow(root)))).flat().join('\n');
    expect(runtime).not.toContain('GmailArchiveCallerKernel');
    expect(runtime).not.toContain('gmail-archive-caller-kernel');
    const genericAdapterRuntime = (await sourceFilesBelow(
      new URL('../', import.meta.url),
      new Set(['gmail-archive-caller-kernel.ts']),
    )).join('\n');
    expect(genericAdapterRuntime).not.toContain('GmailArchiveCallerKernel');
    expect(genericAdapterRuntime).not.toContain('gmail-archive-caller-kernel');
  });
});
