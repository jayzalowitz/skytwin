import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import {
  gmailArchiveFeedbackApplicationTestHooks,
} from '../repositories/gmail-archive-feedback-application-repository.js';

const userId = '11111111-1111-4111-8111-111111111111';
const feedbackEventId = '22222222-2222-4222-8222-222222222222';
const sourceSignalId = '33333333-3333-4333-8333-333333333333';
const sourceConnectorId = 'gmail:account:message';
const appliedAt = '2026-09-12T12:34:56.123456Z';

function inference(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inference-email',
    domain: 'email',
    key: 'archive_newsletters',
    value: true,
    confidence: ConfidenceLevel.LOW,
    supportingEvidenceIds: [sourceSignalId],
    contradictingEvidenceIds: [],
    reasoning: 'Observed from this Gmail message.',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function profileState(inferences: Record<string, unknown>[]) {
  return {
    preferences: [],
    inferences,
    risk_tolerance: {},
    spend_norms: {},
    communication_style: {},
    routines: [],
    domain_heuristics: {},
  };
}

describe('Gmail archive feedback application', () => {
  it.each([
    null,
    {},
    { userId, feedbackEventId: 'bad' },
    { userId: 'bad', feedbackEventId },
    { userId, feedbackEventId, extra: true },
    Object.assign(Object.create({}), { userId, feedbackEventId }),
  ])('rejects hostile or malformed apply input before a transaction: %o', async (input) => {
    const transaction = vi.fn();
    await expect(gmailArchiveFeedbackApplicationTestHooks.applyWithTransition(
      input as never,
      vi.fn(),
      transaction,
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reuses every stable write ID across bounded 40001 retries', async () => {
    const seen: unknown[] = [];
    const transition = vi.fn(async (_client, _input, ids) => {
      seen.push(ids);
      if (seen.length < 3) throw Object.assign(new Error('retry'), { code: '40001' });
      return {
        ok: true as const,
        created: true,
        application: {
          id: ids.application,
          feedbackEventId,
          userId,
          decisionId: '44444444-4444-4444-8444-444444444444',
          profileId: ids.profile,
          inputProfileVersion: 1,
          outputProfileVersion: 1,
          changed: false,
          outputDigest: 'a'.repeat(64),
          appliedAt,
        },
      };
    });
    const transaction = async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> =>
      callback({} as PoolClient);
    await expect(gmailArchiveFeedbackApplicationTestHooks.applyWithTransition(
      { userId, feedbackEventId },
      transition,
      transaction,
    )).resolves.toMatchObject({ ok: true, created: true });
    expect(transition).toHaveBeenCalledTimes(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });

  it('changes only same-domain inferences supported by the decision evidence', () => {
    const state = gmailArchiveFeedbackApplicationTestHooks.snapshotProfileState(profileState([
      inference(),
      inference({
        id: 'connector-evidence',
        confidence: ConfidenceLevel.MODERATE,
        supportingEvidenceIds: [sourceConnectorId],
      }),
      inference({
        id: 'unrelated-same-domain',
        confidence: ConfidenceLevel.HIGH,
        supportingEvidenceIds: ['some-other-signal'],
      }),
      inference({
        id: 'unrelated-domain',
        domain: 'calendar',
        confidence: ConfidenceLevel.HIGH,
      }),
    ]));
    if (!state) throw new Error('fixture was not canonical');
    const projected = gmailArchiveFeedbackApplicationTestHooks.projectProfile(
      state,
      'approve',
      new Set([sourceSignalId, sourceConnectorId]),
      'email',
      appliedAt,
    );
    expect(projected).not.toBeNull();
    expect(projected?.changed).toBe(true);
    expect(projected?.output.inferences.map((item) => item['confidence'])).toEqual([
      ConfidenceLevel.MODERATE,
      ConfidenceLevel.HIGH,
      ConfidenceLevel.HIGH,
      ConfidenceLevel.HIGH,
    ]);
    expect(projected?.output.inferences[0]?.['updatedAt']).toBe('2026-09-12T12:34:56.123Z');
    expect(projected?.output.inferences[2]).toBe(state.inferences[2]);
    expect(projected?.output.inferences[3]).toBe(state.inferences[3]);
  });

  it('records a deterministic no-op at the confidence boundary', () => {
    const state = gmailArchiveFeedbackApplicationTestHooks.snapshotProfileState(profileState([
      inference({ confidence: ConfidenceLevel.CONFIRMED }),
    ]));
    if (!state) throw new Error('fixture was not canonical');
    const projected = gmailArchiveFeedbackApplicationTestHooks.projectProfile(
      state,
      'approve',
      new Set([sourceSignalId]),
      'email',
      appliedAt,
    );
    expect(projected).toEqual({ changed: false, output: state });
  });

  it('fails closed on malformed inference state', () => {
    const state = gmailArchiveFeedbackApplicationTestHooks.snapshotProfileState(profileState([
      inference({ confidence: 'invented' }),
    ]));
    if (!state) throw new Error('JSON fixture should load before semantic validation');
    expect(gmailArchiveFeedbackApplicationTestHooks.projectProfile(
      state,
      'reject',
      new Set([sourceSignalId]),
      'email',
      appliedAt,
    )).toBeNull();
  });

  it('hashes the complete canonical profile output independent of object key order', () => {
    const left = gmailArchiveFeedbackApplicationTestHooks.snapshotProfileState(profileState([
      inference(),
    ]));
    const right = gmailArchiveFeedbackApplicationTestHooks.snapshotProfileState({
      domain_heuristics: {}, routines: [], communication_style: {}, spend_norms: {},
      risk_tolerance: {}, inferences: [inference()], preferences: [],
    });
    if (!left || !right) throw new Error('fixture was not canonical');
    expect(gmailArchiveFeedbackApplicationTestHooks.outputDigest(
      '55555555-5555-4555-8555-555555555555', userId, 4, left,
    )).toBe(gmailArchiveFeedbackApplicationTestHooks.outputDigest(
      '55555555-5555-4555-8555-555555555555', userId, 4, right,
    ));
  });
});

describe('pending Gmail archive feedback selector', () => {
  const row = {
    user_id: userId,
    feedback_event_id: feedbackEventId,
    created_at_text: '2026-09-12 12:34:56.123456',
  };

  it('returns frozen capability-free hints from a bounded SELECT', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const result = await gmailArchiveFeedbackApplicationTestHooks.listPendingWithQuery(
      { limit: 1 }, query,
    );
    expect(result).toMatchObject({
      ok: true,
      candidates: [{ userId, feedbackEventId }],
    });
    if (!result.ok) throw new Error('expected candidates');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.keys(result.candidates[0]!).sort()).toEqual(['feedbackEventId', 'userId']);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain('LEFT JOIN twin_feedback_applications');
    expect(sql).toContain('ORDER BY feedback.created_at ASC, feedback.id ASC');
    expect(sql).toContain('LIMIT $5');
    expect(sql).not.toContain('FOR UPDATE');
    expect(params.at(-1)).toBe(1);
    expect(result.nextCursor).not.toBeNull();
  });

  it('rejects noncanonical and tampered cursors before querying', async () => {
    const firstQuery = vi.fn().mockResolvedValue({ rows: [row] });
    const first = await gmailArchiveFeedbackApplicationTestHooks.listPendingWithQuery(
      { limit: 1 }, firstQuery,
    );
    if (!first.ok || first.nextCursor === null) throw new Error('expected cursor');
    const query = vi.fn();
    await expect(gmailArchiveFeedbackApplicationTestHooks.listPendingWithQuery({
      limit: 1,
      cursor: `${first.nextCursor}x` as never,
    }, query)).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(query).not.toHaveBeenCalled();
  });

  const malformedDriverRows: unknown[][] = [
    [{ ...row, user_id: 'bad' }],
    [{ ...row, extra: true }],
    [row, row],
    [{ ...row, created_at_text: 'not-a-time' }],
  ];

  it.each(malformedDriverRows)(
    'fails closed on malformed or non-increasing driver rows', async (rows) => {
    const driverRows = rows as unknown[];
    const query = vi.fn().mockResolvedValue({ rows: driverRows });
    await expect(gmailArchiveFeedbackApplicationTestHooks.listPendingWithQuery(
      { limit: driverRows.length > 1 ? 2 : 1 }, query,
    )).resolves.toEqual({ ok: false, error: 'integrity_conflict' });
    },
  );
});
