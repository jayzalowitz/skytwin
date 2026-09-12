import { readFile, readdir } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, withTransactionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({ query: queryMock, withTransaction: withTransactionMock }));

const {
  gmailArchiveTerminalStatusRepository,
  gmailArchiveTerminalStatusTestHooks,
} = await import('../repositories/gmail-archive-terminal-status-repository.js');

const input = {
  userId: '11111111-1111-4111-8111-111111111111',
  approvalId: '22222222-2222-4222-8222-222222222222',
};
const revisionId = '33333333-3333-4333-8333-333333333333';
const recordedAt = new Date('2026-09-12T12:00:00.123Z');

function barrier(status: string) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    user_id: input.userId,
    idempotency_key: input.approvalId,
    effect_type: 'event_execution',
    status,
  };
}

function revision(disposition: 'blocked' | 'succeeded' | 'failed' | 'unknown') {
  return {
    id: revisionId,
    stage: disposition === 'blocked' ? 'policy_evaluated' : 'execution_recorded',
    disposition,
    trusted: true,
    created_at: recordedAt,
  };
}

function clientWithBarriers(rows: unknown[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as PoolClient;
}

function dependencySet(overrides: Record<string, unknown> = {}) {
  return {
    loadApprovalState: vi.fn().mockResolvedValue({ canonical: true, revisions: [] }),
    canonicalApprovalContent: vi.fn().mockReturnValue({ approved: true }),
    exactReservedBarrier: vi.fn().mockReturnValue(true),
    loadPreparationReplay: vi.fn().mockResolvedValue({
      ok: true,
      created: false,
      preparation: {
        status: 'blocked',
        barrier: {},
        explanation: {},
        plan: null,
        receipt: {},
        revisions: [{}, {}, {}, {}, revision('blocked')],
      },
    }),
    queryRecovery: vi.fn().mockResolvedValue({
      ok: true,
      status: 'not_due',
      recovery: null,
    }),
    loadTerminalState: vi.fn().mockResolvedValue({ canonical: true }),
    exactApprovedPrefix: vi.fn().mockReturnValue({ approved: true }),
    validateTerminalGraph: vi.fn().mockResolvedValue({
      status: 'succeeded',
      barrier: {},
      plan: {},
      executionResult: {},
      executionExplanation: {},
      revision: revision('succeeded'),
    }),
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

describe('gmailArchiveTerminalStatusRepository', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withTransactionMock.mockReset();
    withTransactionMock.mockImplementation(async (callback) => callback({}));
  });

  it.each([
    null,
    {},
    { ...input, extra: true },
    { ...input, userId: 'invalid' },
    { ...input, approvalId: 'invalid' },
    Object.assign(Object.create({}), input),
  ])('rejects malformed authority before opening a transaction: %o', async (submitted) => {
    await expect(gmailArchiveTerminalStatusRepository.read(submitted as never))
      .resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects symbols, accessors, hidden fields, and revoked proxies without invoking getters', async () => {
    const getter = vi.fn(() => input.userId);
    const accessor = { ...input } as Record<string, unknown>;
    Object.defineProperty(accessor, 'userId', { enumerable: true, get: getter });
    const symbol = { ...input };
    Object.defineProperty(symbol, Symbol('authority'), { enumerable: true, value: true });
    const hidden = { ...input };
    Object.defineProperty(hidden, 'approvalId', {
      enumerable: false,
      value: input.approvalId,
    });
    const revoked = Proxy.revocable({ ...input }, {});
    revoked.revoke();
    for (const submitted of [accessor, symbol, hidden, revoked.proxy]) {
      await expect(gmailArchiveTerminalStatusRepository.read(submitted as never))
        .resolves.toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('snapshots and freezes authority before transaction work', async () => {
    const seen: unknown[] = [];
    const submitted = { ...input };
    const pending = gmailArchiveTerminalStatusTestHooks.readWithTransition(
      submitted,
      async (_client, frozen) => {
        seen.push(frozen);
        return { ok: true, status: 'not_terminal', terminal: null };
      },
      withTransactionMock,
    );
    submitted.approvalId = revisionId;
    await expect(pending).resolves.toEqual({
      ok: true,
      status: 'not_terminal',
      terminal: null,
    });
    expect(seen).toEqual([input]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it('binds the authority query to exact parameter positions and rejects zero or duplicate rows', async () => {
    const dependencies = dependencySet();
    for (const [rows, expected] of [
      [[], { ok: false, error: 'not_found' }],
      [[barrier('reserved'), barrier('reserved')], { ok: false, error: 'integrity_conflict' }],
    ] as const) {
      const client = clientWithBarriers([...rows]);
      await expect(gmailArchiveTerminalStatusTestHooks.readTransition(
        client,
        input,
        dependencies as never,
      )).resolves.toEqual(expected);
      expect(client.query).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT 2'), [
        input.userId,
        input.approvalId,
      ]);
    }
  });

  it('maps a validated blocked r5 and requests a non-locking preparation read', async () => {
    const dependencies = dependencySet();
    const result = await gmailArchiveTerminalStatusTestHooks.readTransition(
      clientWithBarriers([barrier('blocked')]),
      input,
      dependencies as never,
    );
    expect(result).toEqual({
      ok: true,
      status: 'terminal',
      terminal: {
        disposition: 'blocked',
        receiptRevisionId: revisionId,
        recordedAt: recordedAt.toISOString(),
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok && result.status === 'terminal') expect(Object.isFrozen(result.terminal)).toBe(true);
    expect(dependencies.loadApprovalState).toHaveBeenCalledWith(
      expect.anything(),
      { ...input, action: 'approve' },
      { allowExecutionPlan: true, lockRows: false },
    );
  });

  it.each(['succeeded', 'failed', 'unknown'] as const)(
    'maps %s only from a validated matching terminal r7',
    async (disposition) => {
      const validateTerminalGraph = vi.fn().mockResolvedValue({
        status: disposition,
        barrier: {},
        plan: { status: disposition === 'succeeded' ? 'completed' : 'failed' },
        executionResult: disposition === 'unknown' ? null : {},
        executionExplanation: {},
        revision: revision(disposition),
      });
      const dependencies = dependencySet({ validateTerminalGraph });
      await expect(gmailArchiveTerminalStatusTestHooks.readTransition(
        clientWithBarriers([barrier(disposition)]),
        input,
        dependencies as never,
      )).resolves.toEqual({
        ok: true,
        status: 'terminal',
        terminal: {
          disposition,
          receiptRevisionId: revisionId,
          recordedAt: recordedAt.toISOString(),
        },
      });
      expect(dependencies.loadTerminalState).toHaveBeenCalledWith(
        expect.anything(),
        input,
        false,
      );
      expect(validateTerminalGraph).toHaveBeenCalledWith(
        expect.anything(),
        input,
        expect.anything(),
        expect.objectContaining({ status: disposition }),
        expect.anything(),
        { lockRows: false },
      );
    },
  );

  it.each(['reserved', 'prepared', 'in_progress'] as const)(
    'returns no visible disposition for a validated %s graph',
    async (status) => {
      const dependencies = dependencySet(status === 'prepared' ? {
        loadPreparationReplay: vi.fn().mockResolvedValue({
          ok: true,
          created: false,
          preparation: {
            status: 'prepared',
            barrier: {},
            explanation: {},
            plan: {},
            receipt: {},
            revisions: [],
          },
        }),
      } : {});
      await expect(gmailArchiveTerminalStatusTestHooks.readTransition(
        clientWithBarriers([barrier(status)]),
        input,
        dependencies as never,
      )).resolves.toEqual({ ok: true, status: 'not_terminal', terminal: null });
    },
  );

  it('fails closed on corrupt preparation, terminal, plan-only, and hostile validator results', async () => {
    const statusGetter = vi.fn(() => 'succeeded');
    const accessorTerminal = { revision: revision('succeeded') } as Record<string, unknown>;
    Object.defineProperty(accessorTerminal, 'status', { enumerable: true, get: statusGetter });
    const cases = [
      {
        status: 'blocked',
        dependencies: dependencySet({
          loadPreparationReplay: vi.fn().mockResolvedValue({
            ok: true,
            created: false,
            preparation: {
              status: 'blocked',
              revisions: [{}, {}, {}, {}, { ...revision('blocked'), trusted: false }],
            },
          }),
        }),
      },
      {
        status: 'succeeded',
        dependencies: dependencySet({
          validateTerminalGraph: vi.fn().mockResolvedValue({
            status: 'failed',
            revision: revision('failed'),
          }),
        }),
      },
      {
        status: 'unknown',
        dependencies: dependencySet({ validateTerminalGraph: vi.fn().mockResolvedValue(null) }),
      },
      {
        status: 'succeeded',
        dependencies: dependencySet({
          validateTerminalGraph: vi.fn().mockResolvedValue(accessorTerminal),
        }),
      },
    ];
    for (const testCase of cases) {
      await expect(gmailArchiveTerminalStatusTestHooks.readTransition(
        clientWithBarriers([barrier(testCase.status)]),
        input,
        testCase.dependencies as never,
      )).resolves.toEqual({ ok: false, error: 'integrity_conflict' });
    }
    expect(statusGetter).not.toHaveBeenCalled();
  });

  it('retries the complete snapshot transaction twice for 40001 only', async () => {
    const restart = Object.assign(new Error('restart'), { code: '40001' });
    const transition = vi.fn()
      .mockRejectedValueOnce(restart)
      .mockRejectedValueOnce(restart)
      .mockResolvedValue({ ok: true, status: 'not_terminal', terminal: null });
    const transaction = vi.fn().mockImplementation(async (callback) => callback({}));
    await expect(gmailArchiveTerminalStatusTestHooks.readWithTransition(
      input,
      transition,
      transaction,
    )).resolves.toEqual({ ok: true, status: 'not_terminal', terminal: null });
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(transition).toHaveBeenCalledTimes(3);
    const frozenInputs = transition.mock.calls.map((call) => call[1]);
    expect(frozenInputs[0]).toBe(frozenInputs[1]);
    expect(frozenInputs[1]).toBe(frozenInputs[2]);

    const exhausted = vi.fn().mockRejectedValue(restart);
    await expect(gmailArchiveTerminalStatusTestHooks.readWithTransition(
      input,
      vi.fn(),
      exhausted,
    )).rejects.toBe(restart);
    expect(exhausted).toHaveBeenCalledTimes(3);

    const ordinary = Object.assign(new Error('ordinary'), { code: '23514' });
    const nonRetry = vi.fn().mockRejectedValue(ordinary);
    await expect(gmailArchiveTerminalStatusTestHooks.readWithTransition(
      input,
      vi.fn(),
      nonRetry,
    )).rejects.toBe(ordinary);
    expect(nonRetry).toHaveBeenCalledTimes(1);
  });

  it('is SELECT-only, lock-free, leaf-only, and absent from runtime composition', async () => {
    const source = await readFile(
      new URL('../repositories/gmail-archive-terminal-status-repository.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|UPSERT)\b/);
    expect(source).not.toContain('FOR UPDATE');
    expect(source).not.toMatch(/@skytwin\/(?:connectors|credential-vault|execution-router|ironclaw-adapter)/);
    const barrels = await Promise.all([
      readFile(new URL('../repositories/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../index.ts', import.meta.url), 'utf8'),
    ]);
    for (const barrel of barrels) {
      expect(barrel).not.toContain('gmailArchiveTerminalStatusRepository');
      expect(barrel).not.toContain('gmail-archive-terminal-status-repository');
      expect(barrel).not.toContain('GmailArchiveTerminalStatusReaderPort');
      expect(barrel).not.toContain('ReadGmailArchiveTerminalStatusResult');
    }
    const roots = [
      new URL('../../../../apps/api/', import.meta.url),
      new URL('../../../../apps/worker/', import.meta.url),
      new URL('../../../../apps/desktop/', import.meta.url),
      new URL('../../../execution-router/', import.meta.url),
      new URL('../../../ironclaw-adapter/', import.meta.url),
    ];
    const runtimeSources = (await Promise.all(roots.map(sourceFilesBelow))).flat().join('\n');
    expect(runtimeSources).not.toContain('gmailArchiveTerminalStatusRepository');
    expect(runtimeSources).not.toContain('gmail-archive-terminal-status-repository');
  });
});
