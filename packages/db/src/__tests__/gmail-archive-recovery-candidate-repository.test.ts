import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  gmailArchiveRecoveryCandidateRepository,
  gmailArchiveRecoveryCandidateTestHooks,
} from '../repositories/gmail-archive-recovery-candidate-repository.js';

const owner = '11111111-1111-4111-8111-111111111111';
const approval = '22222222-2222-4222-8222-222222222222';
const barrier = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const updatedAtText = '2026-09-12 12:34:56.123456';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: owner,
    approval_id: approval,
    barrier_id: barrier,
    updated_at_text: updatedAtText,
    ...overrides,
  };
}

describe('Gmail archive recovery candidate discovery', () => {
  it.each([
    null,
    {},
    { limit: 0 },
    { limit: 26 },
    { limit: 1.5 },
    { limit: Number.NaN },
    { limit: 25, extra: true },
    { limit: 25, cursor: undefined },
    { limit: 25, cursor: 7 },
    Object.assign(Object.create({}), { limit: 25 }),
  ])('rejects a malformed bound before querying: %o', async (input) => {
    const query = vi.fn();
    await expect(gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
      input as never,
      query,
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(query).not.toHaveBeenCalled();
  });

  it('contains symbols, accessors, and hostile proxies without reading them', async () => {
    const getter = vi.fn(() => 25);
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'limit', { enumerable: true, get: getter });
    const symbol = { limit: 25 };
    Object.defineProperty(symbol, Symbol('extra'), { enumerable: true, value: true });
    const revoked = Proxy.revocable({ limit: 25 }, {});
    revoked.revoke();
    const query = vi.fn();
    for (const input of [accessor, symbol, revoked.proxy]) {
      await expect(gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
        input as never,
        query,
      )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('runs one bounded, stable, nonlocking hint query and returns only frozen owner pairs', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        row(),
        row({
          user_id: '33333333-3333-4333-8333-333333333333',
          approval_id: '44444444-4444-4444-8444-444444444444',
          barrier_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          updated_at_text: '2026-09-12 12:34:57.123456',
        }),
      ],
    });
    const result = await gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
      { limit: 25 },
      query,
    );
    expect(result).toEqual({
      ok: true,
      candidates: [
        { userId: owner, approvalId: approval },
        {
          userId: '33333333-3333-4333-8333-333333333333',
          approvalId: '44444444-4444-4444-8444-444444444444',
        },
      ],
      nextCursor: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.candidates)).toBe(true);
      expect(result.candidates.every(Object.isFrozen)).toBe(true);
      expect(Object.keys(result.candidates[0]!).sort()).toEqual(['approvalId', 'userId']);
    }
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("barrier.status IN ('reserved', 'prepared', 'in_progress')");
    expect(sql).toContain('ORDER BY barrier.updated_at ASC, barrier.id ASC');
    expect(sql).toContain("(barrier.updated_at AT TIME ZONE 'UTC')::STRING");
    expect(sql).toContain('(barrier.updated_at, barrier.id) > ($4::TIMESTAMPTZ, $5::UUID)');
    expect(sql).toContain('LIMIT $6');
    expect(sql).toContain("lease.observation_state = 'started'");
    expect(sql).not.toContain('FOR UPDATE');
    expect(params).toEqual(['gmail_inbox_mutation_v1', 300, false, null, null, 25]);
  });

  const malformedRows: unknown[][] = [
    [row({ approval_id: 'invalid' })],
    [row({ extra: true })],
    [row(), row()],
    [row({ updated_at_text: '2026-09-12 12:34:56.1234567' })],
    Array.from({ length: 26 }, (_, index) => row({
      barrier_id: `${String(index).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    })),
  ];

  it.each(malformedRows)(
    'fails closed if the DB driver returns malformed or duplicate hints',
    async (rows) => {
      const query = vi.fn().mockResolvedValue({ rows });
      await expect(gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
        { limit: 25 },
        query,
      )).resolves.toEqual({ ok: false, error: 'integrity_conflict' });
    },
  );

  it('rejects a driver result larger than the submitted bound', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: Array.from({ length: 2 }, (_, index) => ({
        user_id: `${index + 1}1111111-1111-4111-8111-111111111111`,
        approval_id: `${index + 3}2222222-2222-4222-8222-222222222222`,
        barrier_id: `${index + 5}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        updated_at_text: `2026-09-12 12:34:5${index}.123456`,
      })),
    });
    await expect(gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
      { limit: 1 },
      query,
    )).resolves.toEqual({ ok: false, error: 'integrity_conflict' });
  });

  it('validates DB ordering losslessly across millisecond and microsecond neighbors', () => {
    expect(gmailArchiveRecoveryCandidateTestHooks.snapshotPage([
      row({ updated_at_text: '2026-09-12 12:34:56.123' }),
      row({
        approval_id: '33333333-3333-4333-8333-333333333333',
        barrier_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        updated_at_text: '2026-09-12 12:34:56.123001',
      }),
    ], 25)).not.toBeNull();
    expect(gmailArchiveRecoveryCandidateTestHooks.snapshotPage([
      row({ updated_at_text: '2026-09-12 12:34:56.123001' }),
      row({
        approval_id: '33333333-3333-4333-8333-333333333333',
        barrier_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        updated_at_text: '2026-09-12 12:34:56.123',
      }),
    ], 25)).toBeNull();
  });

  it('issues an opaque continuation with a decreasing hard sweep budget', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row()] })
      .mockResolvedValueOnce({ rows: [row({
        approval_id: '33333333-3333-4333-8333-333333333333',
        barrier_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        updated_at_text: '2026-09-12 12:34:57.123456',
      })] });
    const first = await gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
      { limit: 1 },
      query,
    );
    expect(first).toMatchObject({ ok: true, candidates: [{ userId: owner, approvalId: approval }] });
    if (!first.ok || first.nextCursor === null) throw new Error('expected continuation');
    expect(typeof first.nextCursor).toBe('string');
    expect(Object.isFrozen(first.nextCursor)).toBe(true);
    expect(first.nextCursor).not.toContain(updatedAtText);
    expect(first.nextCursor).not.toContain(barrier);
    expect(gmailArchiveRecoveryCandidateTestHooks.parseCursor(first.nextCursor)).toEqual({
      updatedAt: '2026-09-12T12:34:56.123456Z',
      barrierId: barrier,
      remaining: 99,
    });
    expect(Object.keys(first.candidates[0]!).sort()).toEqual(['approvalId', 'userId']);

    const second = await gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
      { limit: 1, cursor: first.nextCursor },
      query,
    );
    expect(second).toMatchObject({ ok: true, candidates: [{
      userId: owner,
      approvalId: '33333333-3333-4333-8333-333333333333',
    }] });
    const [, secondParams] = query.mock.calls[1]!;
    expect(secondParams).toEqual([
      'gmail_inbox_mutation_v1',
      300,
      true,
      '2026-09-12T12:34:56.123456Z',
      barrier,
      1,
    ]);
  });

  it('fails closed for tampered, noncanonical, and exhausted cursors', async () => {
    const valid = gmailArchiveRecoveryCandidateTestHooks.encodeCursor({
      updatedAt: '2026-09-12T12:34:56.123456Z',
      barrierId: barrier,
      remaining: 75,
    });
    const tampered = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`;
    const noncanonical = `${valid}=`;
    const noncanonicalTimestamp = gmailArchiveRecoveryCandidateTestHooks.encodeCursor({
      updatedAt: '2026-09-12T12:34:56.123000Z',
      barrierId: barrier,
      remaining: 75,
    });
    const exhausted = gmailArchiveRecoveryCandidateTestHooks.encodeCursor({
      updatedAt: '2026-09-12T12:34:56.123456Z',
      barrierId: barrier,
      remaining: 0,
    });
    const query = vi.fn();
    for (const cursor of [tampered, noncanonical, noncanonicalTimestamp, exhausted]) {
      await expect(gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
        { limit: 25, cursor } as never,
        query,
      )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('cannot emit a continuation beyond the cursor sweep budget', async () => {
    const cursor = gmailArchiveRecoveryCandidateTestHooks.encodeCursor({
      updatedAt: '2026-09-12T12:34:55.123456Z',
      barrierId: '99999999-9999-4999-8999-999999999999',
      remaining: 1,
    });
    const query = vi.fn().mockResolvedValue({ rows: [row()] });
    await expect(gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
      { limit: 25, cursor },
      query,
    )).resolves.toEqual({
      ok: true,
      candidates: [{ userId: owner, approvalId: approval }],
      nextCursor: null,
    });
    expect(query.mock.calls[0]![1]?.[5]).toBe(1);
  });

  it('does not convert an infrastructure failure into scheduling authority', async () => {
    const failure = new Error('database unavailable');
    await expect(gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
      { limit: 25 },
      vi.fn().mockRejectedValue(failure),
    )).rejects.toBe(failure);
  });

  it('keeps the repository private while the aggregate is the only barrel export', async () => {
    const [repositoryBarrel, rootBarrel, source] = await Promise.all([
      readFile(new URL('../repositories/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../index.ts', import.meta.url), 'utf8'),
      readFile(
        new URL('../repositories/gmail-archive-recovery-candidate-repository.ts', import.meta.url),
        'utf8',
      ),
    ]);
    for (const barrel of [repositoryBarrel, rootBarrel]) {
      expect(barrel).toContain('gmailArchiveRuntimeRepositories');
      expect(barrel).not.toContain('gmailArchiveRecoveryCandidateRepository');
      expect(barrel).not.toContain('gmail-archive-recovery-candidate-repository');
      expect(barrel).not.toContain('gmailArchiveRecordedObservationReconciliationRepository');
      expect(barrel).not.toContain('gmailArchiveTerminalStatusRepository');
    }
    expect(source).not.toMatch(/@skytwin\/(?:connectors|credential-vault|ironclaw-adapter)/);
    expect(source).not.toMatch(/access_token|refresh_token|provider_message_id|observation_evidence/);
    expect(gmailArchiveRecoveryCandidateTestHooks.defaultPageLimit).toBe(25);
    expect(gmailArchiveRecoveryCandidateTestHooks.maxPageLimit).toBe(25);
    expect(gmailArchiveRecoveryCandidateTestHooks.maxSweepCandidates).toBe(100);
    expect(gmailArchiveRecoveryCandidateRepository).toBeDefined();
  });
});
