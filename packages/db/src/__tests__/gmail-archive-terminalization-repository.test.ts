import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, withTransactionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({ query: queryMock, withTransaction: withTransactionMock }));

const {
  buildGmailArchiveTerminalResultEnvelope,
  gmailArchiveTerminalizationRepository,
  gmailArchiveTerminalizationTestHooks,
  parseGmailArchiveTerminalExplanationEvidence,
  parseGmailArchiveTerminalResultEnvelope,
} = await import('../repositories/gmail-archive-terminalization-repository.js');

const command = {
  userId: '11111111-1111-4111-8111-111111111111',
  admissionId: '22222222-2222-4222-8222-222222222222',
  messageRefId: '33333333-3333-4333-8333-333333333333',
  operation: 'archive' as const,
};
const confirmed = {
  outcome: 'confirmed' as const,
  operation: 'archive' as const,
  inbox: false as const,
  effect: 'changed' as const,
  compensationAvailable: false as const,
  observedAt: '2026-09-12T12:00:00.000Z',
};
const knownFailure = {
  outcome: 'known_failure' as const,
  code: 'remote_rejected' as const,
  compensationAvailable: false as const,
};
const unknown = {
  outcome: 'unknown' as const,
  code: 'remote_outcome_unknown' as const,
  compensationAvailable: false as const,
};
const stable = {
  explanationId: '44444444-4444-4444-8444-444444444444',
  resultId: '55555555-5555-4555-8555-555555555555',
  revisionId: '66666666-6666-4666-8666-666666666666',
  persistedAt: '2026-09-12T12:00:01.000Z',
};

describe('gmailArchiveTerminalizationRepository boundary', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ persisted_at: new Date(stable.persistedAt) }] });
    withTransactionMock.mockReset();
  });

  it.each([
    null,
    {},
    { command, result: confirmed, extra: true },
    { command: { ...command, userId: 'invalid' }, result: confirmed },
    { command: { ...command, admissionId: 'invalid' }, result: confirmed },
    { command: { ...command, messageRefId: 'invalid' }, result: confirmed },
    { command: { ...command, operation: 'restore' }, result: confirmed },
    { command, result: { ...confirmed, extra: true } },
    { command, result: { ...confirmed, observedAt: 'not-an-instant' } },
    { command, result: { ...confirmed, compensationAvailable: true } },
    { command, result: { ...knownFailure, code: 'raw-provider-error' } },
    { command, result: { ...unknown, code: 'remote_rejected' } },
  ])('rejects malformed input before a transaction: %o', async (input) => {
    await expect(gmailArchiveTerminalizationRepository.terminalize(input as never)).resolves.toEqual({
      ok: false,
      error: 'invalid_input',
    });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects outer, command, and every result-branch accessor without invoking it', async () => {
    const getters = [vi.fn(() => command), vi.fn(() => command.userId), vi.fn(() => 'confirmed')];
    const outer = { result: confirmed } as Record<string, unknown>;
    Object.defineProperty(outer, 'command', { enumerable: true, get: getters[0] });
    const accessorCommand = { ...command };
    Object.defineProperty(accessorCommand, 'userId', { enumerable: true, get: getters[1] });
    const accessorResults = [confirmed, knownFailure, unknown].map((result) => {
      const copy = { ...result } as Record<string, unknown>;
      Object.defineProperty(copy, 'outcome', { enumerable: true, get: getters[2] });
      return copy;
    });
    for (const input of [
      outer,
      { command: accessorCommand, result: confirmed },
      ...accessorResults.map((result) => ({ command, result })),
    ]) {
      await expect(gmailArchiveTerminalizationRepository.terminalize(input as never)).resolves.toEqual({
        ok: false,
        error: 'invalid_input',
      });
    }
    getters.forEach((getter) => expect(getter).not.toHaveBeenCalled());
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('contains symbols, non-enumerable keys, revoked proxies, and throwing proxies', async () => {
    const symbolOuter = { command, result: confirmed };
    Object.defineProperty(symbolOuter, Symbol('extra'), { enumerable: true, value: true });
    const nonEnumerableCommand = { ...command };
    Object.defineProperty(nonEnumerableCommand, 'userId', { enumerable: false, value: command.userId });
    const symbolResults = [confirmed, knownFailure, unknown].map((result) => {
      const copy = { ...result };
      Object.defineProperty(copy, Symbol('extra'), { enumerable: true, value: true });
      return copy;
    });
    const revokedOuter = Proxy.revocable({ command, result: confirmed }, {});
    revokedOuter.revoke();
    const revokedCommand = Proxy.revocable({ ...command }, {});
    revokedCommand.revoke();
    const throwingResult = new Proxy({ ...knownFailure }, {
      ownKeys() {
        throw new Error('contained');
      },
    });
    for (const input of [
      symbolOuter,
      { command: nonEnumerableCommand, result: confirmed },
      ...symbolResults.map((result) => ({ command, result })),
      revokedOuter.proxy,
      { command: revokedCommand.proxy, result: confirmed },
      { command, result: throwingResult },
    ]) {
      await expect(gmailArchiveTerminalizationRepository.terminalize(input as never)).resolves.toEqual({
        ok: false,
        error: 'invalid_input',
      });
    }
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('never coerces hostile discriminator values', async () => {
    const primitive = vi.fn(() => {
      throw new Error('must not coerce');
    });
    const hostile = { [Symbol.toPrimitive]: primitive, toString: primitive };
    for (const result of [
      { ...confirmed, effect: hostile },
      { ...knownFailure, code: hostile },
      { ...unknown, outcome: hostile },
    ]) {
      await expect(gmailArchiveTerminalizationRepository.terminalize({ command, result } as never))
        .resolves.toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(primitive).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it.each([confirmed, knownFailure, unknown])(
    'round-trips the exact secret-free terminal envelope for $outcome',
    (result) => {
      const envelope = buildGmailArchiveTerminalResultEnvelope(result, 'dispatch_may_have_started');
      expect(parseGmailArchiveTerminalResultEnvelope(envelope)).toEqual(result);
      expect(parseGmailArchiveTerminalExplanationEvidence([envelope])).toEqual(result);
      expect(parseGmailArchiveTerminalResultEnvelope({ ...envelope, extra: true })).toBeNull();
      expect(parseGmailArchiveTerminalExplanationEvidence([])).toBeNull();
      expect(parseGmailArchiveTerminalExplanationEvidence([envelope, envelope])).toBeNull();
    },
  );

  it('snapshots command/result and reuses stable IDs and time across bounded 40001 retries', async () => {
    withTransactionMock.mockImplementation(async (callback) => callback({}));
    const observations: unknown[] = [];
    let attempt = 0;
    const submitted = { command: { ...command }, result: { ...confirmed } };
    const pending = gmailArchiveTerminalizationTestHooks.terminalizeWithTransition(
      submitted,
      async (_client, snapshot, stableSnapshot) => {
        observations.push({ snapshot, stableSnapshot });
        attempt += 1;
        if (attempt < 3) throw Object.assign(new Error('restart'), { code: '40001' });
        return { ok: false, error: 'not_ready' };
      },
      () => stable,
    );
    submitted.command.messageRefId = '77777777-7777-4777-8777-777777777777';
    (submitted.result as { effect: string }).effect = 'reconciled';
    await expect(pending).resolves.toEqual({ ok: false, error: 'not_ready' });
    expect(withTransactionMock).toHaveBeenCalledTimes(3);
    expect(observations).toHaveLength(3);
    expect(observations[0]).toEqual(observations[1]);
    expect(observations[1]).toEqual(observations[2]);
    const first = observations[0] as { snapshot: typeof submitted; stableSnapshot: typeof stable };
    expect(first.snapshot).toEqual({ command, result: confirmed });
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.command)).toBe(true);
    expect(Object.isFrozen(first.snapshot.result)).toBe(true);
    expect(first.stableSnapshot).toEqual(stable);
    expect(Object.isFrozen(first.stableSnapshot)).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith('SELECT now() AS persisted_at');
  });

  it('rejects a provider observation after the preallocated terminal timestamp', async () => {
    await expect(gmailArchiveTerminalizationTestHooks.terminalizeWithTransition(
      {
        command,
        result: { ...confirmed, observedAt: '2026-09-12T12:00:02.000Z' },
      },
      async () => ({ ok: false, error: 'not_ready' }),
      () => stable,
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('contains no provider, credential, router, or network runtime dependency', async () => {
    const source = await readFile(
      new URL('../repositories/gmail-archive-terminalization-repository.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/@skytwin\/(?:connectors|credential-vault|execution-router|ironclaw-adapter)/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
