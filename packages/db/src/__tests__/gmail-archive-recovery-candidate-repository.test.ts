import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  gmailArchiveRecoveryCandidateRepository,
  gmailArchiveRecoveryCandidateTestHooks,
} from '../repositories/gmail-archive-recovery-candidate-repository.js';

const owner = '11111111-1111-4111-8111-111111111111';
const approval = '22222222-2222-4222-8222-222222222222';

describe('Gmail archive recovery candidate discovery', () => {
  it.each([
    null,
    {},
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: Number.NaN },
    { limit: 25, extra: true },
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
        { user_id: owner, approval_id: approval },
        {
          user_id: '33333333-3333-4333-8333-333333333333',
          approval_id: '44444444-4444-4444-8444-444444444444',
        },
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
    expect(sql).toContain('LIMIT $3');
    expect(sql).toContain("lease.observation_state = 'started'");
    expect(sql).not.toContain('FOR UPDATE');
    expect(params).toEqual(['gmail_inbox_mutation_v1', 300, 25]);
  });

  const malformedRows: unknown[][] = [
    [{ user_id: owner, approval_id: 'invalid' }],
    [{ user_id: owner, approval_id: approval, extra: true }],
    [{ user_id: owner, approval_id: approval }, { user_id: owner, approval_id: approval }],
    Array.from({ length: 101 }, () => ({ user_id: owner, approval_id: approval })),
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
      })),
    });
    await expect(gmailArchiveRecoveryCandidateTestHooks.listWithQuery(
      { limit: 1 },
      query,
    )).resolves.toEqual({ ok: false, error: 'integrity_conflict' });
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
    expect(gmailArchiveRecoveryCandidateTestHooks.defaultLimit).toBe(25);
    expect(gmailArchiveRecoveryCandidateTestHooks.maxLimit).toBe(100);
    expect(gmailArchiveRecoveryCandidateRepository).toBeDefined();
  });
});
