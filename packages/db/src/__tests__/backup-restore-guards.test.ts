/**
 * backup-restore-guards.test.ts — validation + pre-DB guards in restoreBackup
 * and validateBackupData (#400).
 *
 * The connection + repository modules are mocked so these tests run without a
 * real DB. They cover the paths that should reject BEFORE any write happens:
 * malformed payloads, unsupported schema versions, and an already-existing
 * user. The happy-path DB write itself is covered end-to-end against a real
 * CRDB in the e2e suite; here we assert the guards fail closed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  joinedDecisionReceiptRevisionDigest,
} from '@skytwin/shared-types';

let userExists = false;
const poolQuery = vi.fn(async (..._args: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => ({
  rows: [], rowCount: 0,
}));
const clientQuery = vi.fn(async (..._args: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => ({
  rows: [], rowCount: 1,
}));

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => poolQuery(...args),
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: clientQuery }),
  ),
}));

vi.mock('../repositories/user-repository.js', () => ({
  userRepository: {
    findById: vi.fn(async () => (userExists ? { id: 'u1' } : null)),
  },
}));

vi.mock('../repositories/twin-repository.js', () => ({
  twinRepository: { getProfile: vi.fn(async () => null) },
}));

import { restoreBackup, validateBackupData, BACKUP_SCHEMA_VERSION } from '../backup/backup.js';

beforeEach(() => {
  userExists = false;
  poolQuery.mockClear();
  poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  clientQuery.mockClear();
  clientQuery.mockImplementation(async (sql: unknown) => ({
    rows: userExists && typeof sql === 'string' && sql.includes('SELECT id FROM users')
      ? [{ id: 'u1' }]
      : [],
    rowCount: 1,
  }));
});

function validPayload(): Record<string, unknown> {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: '2026-06-15T00:00:00.000Z',
    user: {
      id: 'u1',
      email: 'a@b.c',
      name: 'A',
      trust_tier: 'observer',
      autonomy_settings: {},
      ironclaw_channel: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
    twinProfile: null,
    twinProfileVersions: [],
    preferences: [],
    decisions: [],
  };
}

describe('validateBackupData', () => {
  it('accepts a well-formed payload', () => {
    expect(validateBackupData(validPayload())).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateBackupData('nope')).toContain('payload is not an object');
    expect(validateBackupData(null)).toContain('payload is not an object');
  });

  it('reports each missing required field', () => {
    const problems = validateBackupData({ schemaVersion: 1 });
    expect(problems).toContain('missing user');
    expect(problems).toContain('preferences is not an array');
    expect(problems).toContain('decisions is not an array');
    expect(problems).toContain('twinProfileVersions is not an array');
  });

  it('rejects receipt metadata whose signed linkage disagrees with its decision bundle', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a' }, candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a' }],
      inferenceReceipts: [{
        id: 'receipt-a', decision_id: 'decision-a', explanation_id: 'explanation-a', status: 'verified',
        receipt: { id: 'receipt-a', decisionId: 'decision-b', explanationId: 'explanation-a', status: 'verified' },
      }],
    }];
    expect(validateBackupData(payload)).toContain(
      'decisions[0].inferenceReceipts[0] has inconsistent linkage',
    );
  });

  it('rejects an explanation linked to a different decision than its containing bundle', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a' }, candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a', decision_id: 'decision-b' }], inferenceReceipts: [],
    }];
    expect(validateBackupData(payload)).toContain(
      'decisions[0].explanations[0] has inconsistent linkage',
    );
  });

  it('rejects malformed nested collections without throwing', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'u1' },
      candidateActions: {}, explanations: {}, inferenceReceipts: {},
    }];
    expect(() => validateBackupData(payload)).not.toThrow();
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0].candidateActions is not an array',
      'decisions[0].explanations is not an array',
      'decisions[0].inferenceReceipts is not an array',
    ]));
  });

  it('rejects malformed joined receipt nesting without throwing', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'u1' }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [], joinedReceipt: {},
    }];
    expect(() => validateBackupData(payload)).not.toThrow();
    expect(validateBackupData(payload)).toContain('decisions[0].joinedReceipt is malformed');
  });

  it('validates the joined receipt owner, sequence, digest chain, and event uniqueness', () => {
    const payload = validPayload();
    const joinedDecisionId = '22222222-2222-4222-8222-222222222222';
    const joinedRootId = '33333333-3333-4333-8333-333333333333';
    const joinedUserId = '11111111-1111-4111-8111-111111111111';
    const content = {
      version: 1 as const, stage: 'decision_recorded' as const, disposition: 'pending' as const,
      policyEvaluations: [],
      decision: {
        id: joinedDecisionId,
        canonicalHash: joinedDecisionReceiptArtifactDigest('decision', {
          id: joinedDecisionId, user_id: joinedUserId,
        }),
      },
      evidence: [], inference: { receipts: [] }, feedbackEvents: [], corrections: [],
    };
    payload['user'] = { ...(payload['user'] as object), id: joinedUserId };
    const contentDigest = joinedDecisionReceiptContentDigest(content);
    const receiptEventKey = buildDecisionReceiptEventKey('created', '55555555-5555-4555-8555-555555555555');
    payload['decisions'] = [{
      decision: { id: joinedDecisionId, user_id: joinedUserId }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [],
      joinedReceipt: {
        root: { id: joinedRootId, user_id: joinedUserId, decision_id: joinedDecisionId, created_at: new Date() },
        revisions: [{
          id: '44444444-4444-4444-8444-444444444444', receipt_id: joinedRootId, sequence: '1',
          event_key: receiptEventKey,
          previous_digest: null, content_digest: contentDigest,
          revision_digest: joinedDecisionReceiptRevisionDigest({
            revisionId: '44444444-4444-4444-8444-444444444444',
            receiptId: joinedRootId, decisionId: joinedDecisionId, userId: joinedUserId,
            sequence: 1, eventKey: receiptEventKey, previousDigest: null, contentDigest,
          }),
          stage: content.stage, disposition: content.disposition, content,
          candidate_action_id: null, barrier_id: null, explanation_id: null,
          approval_request_id: null, execution_plan_id: null, execution_result_id: null,
          execution_disposition: null,
          correction_of_revision_id: null, trusted: true,
        }],
      },
    }];
    expect(validateBackupData(payload)).toEqual([]);
    const revision = ((payload['decisions'] as Array<Record<string, unknown>>)[0]!
      ['joinedReceipt'] as { revisions: Array<Record<string, unknown>> }).revisions[0]!;
    revision['sequence'] = '1';
    expect(validateBackupData(payload)).toEqual([]);
    for (const invalidSequence of [true, [1], '01', ' 1', '1 ', 0, -1, 1.5]) {
      revision['sequence'] = invalidSequence;
      expect(validateBackupData(payload)).toContain(
        'decisions[0].joinedReceipt.revisions[0] has inconsistent chain',
      );
    }
    revision['sequence'] = 1;
    const decision = (payload['decisions'] as Array<{ decision: Record<string, unknown> }>)[0]!.decision;
    decision['domain'] = 'tampered-after-receipt';
    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt.revisions[0] has inconsistent chain',
    );
    delete decision['domain'];
    revision['previous_digest'] = 'f'.repeat(64);
    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt.revisions[0] has inconsistent chain',
    );
  });

  it('rejects execution-plan payloads instead of exporting portable provider content', () => {
    const payload = validPayload();
    const decisionId = '22222222-2222-4222-8222-222222222222';
    payload['user'] = { ...(payload['user'] as object), id: '11111111-1111-4111-8111-111111111111' };
    payload['decisions'] = [{
      decision: { id: decisionId, user_id: '11111111-1111-4111-8111-111111111111' },
      candidateActions: [], outcome: null, explanations: [], inferenceReceipts: [],
      executionPlans: [{
        id: '33333333-3333-4333-8333-333333333333', decision_id: decisionId,
        action_id: null, status: 'failed',
        steps: [{ accessToken: 'SECRET_MARKER', providerError: 'raw body' }],
        created_at: new Date(), updated_at: new Date(),
      }],
    }];
    expect(validateBackupData(payload)).toContain('decisions[0] has inconsistent execution linkage');
  });

  it('rejects cross-decision candidate and outcome linkage before restore', () => {
    const payload = validPayload();
    const owner = '11111111-1111-4111-8111-111111111111';
    const firstDecision = '22222222-2222-4222-8222-222222222222';
    const secondDecision = '33333333-3333-4333-8333-333333333333';
    const candidateId = '44444444-4444-4444-8444-444444444444';
    const planId = '55555555-5555-4555-8555-555555555555';
    payload['user'] = { ...(payload['user'] as object), id: owner };
    payload['decisions'] = [{
      decision: { id: firstDecision, user_id: owner },
      candidateActions: [{ id: candidateId, decision_id: secondDecision }],
      explanations: [], inferenceReceipts: [], executionPlans: [],
      outcome: {
        id: '66666666-6666-4666-8666-666666666666', decision_id: firstDecision,
        selected_action_id: candidateId, execution_plan_id: planId,
      },
    }, {
      decision: { id: secondDecision, user_id: owner }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [], executionPlans: [],
    }];
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0] has inconsistent candidate linkage',
      'decisions[0] has inconsistent outcome linkage',
    ]));
  });

  it('rejects decisions and signed receipts attributed to another archive owner', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'another-user' }, candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a', decision_id: 'decision-a' }],
      inferenceReceipts: [{
        id: 'receipt-a', decision_id: 'decision-a', explanation_id: 'explanation-a', status: 'on_device',
        receipt: {
          id: 'receipt-a', userId: 'another-user', decisionId: 'decision-a',
          explanationId: 'explanation-a', status: 'on_device',
        },
      }],
    }];
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0] has inconsistent owner',
      'decisions[0].inferenceReceipts[0] has inconsistent linkage',
    ]));
  });
});

describe('restoreBackup guards', () => {
  it('rejects an invalid payload before any DB write', async () => {
    const result = await restoreBackup({ not: 'a backup' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('invalid_data');
  });

  it('rejects an unsupported schema version', async () => {
    const payload = { ...validPayload(), schemaVersion: 999 };
    const result = await restoreBackup(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('unsupported_schema');
  });

  it('refuses to clobber an existing user (fresh-install only)', async () => {
    userExists = true;
    const result = await restoreBackup(validPayload());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('user_exists');
  });

  it('restores a fresh install and reports row counts', async () => {
    userExists = false;
    const result = await restoreBackup(validPayload());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.summary.counts.users).toBe(1);
      expect(result.summary.total).toBeGreaterThanOrEqual(1);
    }
  });

  it('retries a serialization failure and then restores once', async () => {
    let failOnce = true;
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error('retry'), { code: '40001' });
      }
      return { rows: [], rowCount: typeof sql === 'string' && sql.includes('SELECT id FROM users') ? 0 : 1 };
    });
    await expect(restoreBackup(validPayload())).resolves.toMatchObject({ success: true });
    expect(clientQuery.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('SELECT id FROM users'))).toHaveLength(2);
  });

  it('classifies a 23505 as user_exists only after verifying the same user id', async () => {
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM users')) {
        return { rows: [], rowCount: 0 };
      }
      throw Object.assign(new Error('unique'), { code: '23505' });
    });
    poolQuery.mockResolvedValue({ rows: [{ id: 'u1' }], rowCount: 1 });
    await expect(restoreBackup(validPayload())).resolves.toMatchObject({
      success: false, reason: 'user_exists',
    });
    expect(poolQuery).toHaveBeenCalledWith('SELECT id FROM users WHERE id = $1', ['u1']);
  });

  it('reports a non-user 23505 as invalid backup data', async () => {
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM users')) {
        return { rows: [], rowCount: 0 };
      }
      throw Object.assign(new Error('unique'), { code: '23505' });
    });
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(restoreBackup(validPayload())).resolves.toEqual({
      success: false,
      reason: 'invalid_data',
      message: 'backup restore encountered a conflicting unique artifact',
    });
  });

  it('restores joined receipt roots and revisions without an update path', async () => {
    const payload = validPayload();
    const joinedDecisionId = '22222222-2222-4222-8222-222222222222';
    const joinedRootId = '33333333-3333-4333-8333-333333333333';
    const joinedUserId = '11111111-1111-4111-8111-111111111111';
    const decisionRow = {
      id: joinedDecisionId, user_id: joinedUserId, situation_type: 'test', raw_event: {},
      interpreted_situation: {}, domain: 'test', urgency: 'normal', metadata: {}, created_at: new Date(),
    };
    const content = {
      version: 1 as const, stage: 'decision_recorded' as const, disposition: 'pending' as const,
      policyEvaluations: [],
      decision: {
        id: joinedDecisionId,
        canonicalHash: joinedDecisionReceiptArtifactDigest('decision', {
          id: joinedDecisionId, user_id: joinedUserId, situation_type: 'test', raw_event: {},
          interpreted_situation: {}, domain: 'test', urgency: 'normal', metadata: {},
        }),
      },
      evidence: [], inference: { receipts: [] }, feedbackEvents: [], corrections: [],
    };
    payload['user'] = { ...(payload['user'] as object), id: joinedUserId };
    const contentDigest = joinedDecisionReceiptContentDigest(content);
    const receiptEventKey = buildDecisionReceiptEventKey('created', '55555555-5555-4555-8555-555555555555');
    payload['decisions'] = [{
      decision: decisionRow,
      candidateActions: [], outcome: null, explanations: [], inferenceReceipts: [],
      joinedReceipt: {
        root: { id: joinedRootId, user_id: joinedUserId, decision_id: joinedDecisionId, created_at: new Date() },
        revisions: [{
          id: '44444444-4444-4444-8444-444444444444', receipt_id: joinedRootId, sequence: '1',
          event_key: receiptEventKey,
          previous_digest: null, content_digest: contentDigest,
          revision_digest: joinedDecisionReceiptRevisionDigest({
            revisionId: '44444444-4444-4444-8444-444444444444',
            receiptId: joinedRootId, decisionId: joinedDecisionId, userId: joinedUserId,
            sequence: 1, eventKey: receiptEventKey, previousDigest: null, contentDigest,
          }),
          stage: content.stage, disposition: content.disposition, content,
          candidate_action_id: null, barrier_id: null, explanation_id: null,
          approval_request_id: null, execution_plan_id: null, execution_result_id: null,
          execution_disposition: null,
          correction_of_revision_id: null, created_at: new Date(),
          trusted: true,
        }],
      },
    }];
    const result = await restoreBackup(payload);
    expect(result).toMatchObject({ success: true, summary: { counts: {
      decision_receipts: 1, decision_receipt_revisions: 1,
    } } });
    expect(clientQuery.mock.calls.some(([sql]) =>
      typeof sql === 'string' && /UPDATE\s+decision_receipt/iu.test(sql))).toBe(false);
    const revisionInsert = clientQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO decision_receipt_revisions'));
    const revisionParams = revisionInsert?.[1] as unknown[] | undefined;
    expect(revisionParams?.[2]).toBe(1);
  });

  it('aborts instead of reporting a receipt whose linkage insert affected no row', async () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'u1' },
      candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a', decision_id: 'decision-a' }],
      inferenceReceipts: [{
        id: 'receipt-a', version: 1, decision_id: 'decision-a', explanation_id: 'explanation-a',
        status: 'on_device', receipt: {
          id: 'receipt-a', userId: 'u1', decisionId: 'decision-a', explanationId: 'explanation-a', status: 'on_device',
        }, created_at: new Date(),
      }],
    }];
    clientQuery.mockImplementation(async (sql: unknown) => ({
      rows: [], rowCount: typeof sql === 'string' && sql.includes('INSERT INTO inference_receipts') ? 0 : 1,
    }));
    await expect(restoreBackup(payload)).rejects.toThrow('could not be linked during restore');
  });
});
