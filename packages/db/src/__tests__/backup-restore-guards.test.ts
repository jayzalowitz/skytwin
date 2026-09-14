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

import { generateKeyPairSync } from 'node:crypto';
import {
  sha256Hex,
  signInferenceReceipt,
  type InferenceReceiptV1,
} from '@skytwin/shared-types';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let userExists = false;
const clientQuery = vi.fn(async (_sql?: unknown, _args?: unknown[]) => ({ rows: [], rowCount: 1 }));

vi.mock('../connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
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

const receiptKeys = generateKeyPairSync('ed25519');
const receiptPublicKeyPem = receiptKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const receiptPrivateKeyPem = receiptKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const DECISION_ID = '33333333-3333-4333-8333-333333333333';
const EXPLANATION_ID = '44444444-4444-4444-8444-444444444444';

function signedReceipt(
  overrides: Partial<Omit<InferenceReceiptV1, 'seal'>> = {},
): InferenceReceiptV1 {
  return signInferenceReceipt({
    version: 1,
    id: RECEIPT_ID,
    userId: USER_ID,
    decisionId: DECISION_ID,
    explanationId: EXPLANATION_ID,
    reasoningMode: 'on_device',
    provider: 'embedded',
    model: 'local',
    endpointIdentity: 'local',
    requestSha256: sha256Hex(Buffer.from('request')),
    responseSha256: sha256Hex(Buffer.from('response')),
    verifierVersion: '1',
    cost: { basis: 'exact', currency: 'USD', amountMinor: 0 },
    status: 'on_device',
    createdAt: '2026-06-15T00:00:00.000Z',
    ...overrides,
  }, {
    keyId: 'recorder',
    privateKeyPem: receiptPrivateKeyPem,
    publicKeyPem: receiptPublicKeyPem,
  });
}

function decisionBundle(receipt = signedReceipt()): Record<string, unknown> {
  return {
    decision: { id: DECISION_ID, user_id: USER_ID },
    candidateActions: [],
    outcome: null,
    explanations: [{ id: EXPLANATION_ID, decision_id: DECISION_ID }],
    inferenceReceipts: [{
      id: receipt.id,
      version: receipt.version,
      decision_id: receipt.decisionId,
      explanation_id: receipt.explanationId,
      status: receipt.status,
      receipt,
      trusted: false,
      created_at: new Date(receipt.createdAt),
    }],
    ingestState: {
      decisionId: DECISION_ID,
      receiptCaptureComplete: true,
      receiptExplanationId: EXPLANATION_ID,
      continuationKind: 'non_effect',
      confirmationLevel: null,
      effectState: 'non_effect',
      sourceEffectState: null,
      sourceExecutionStatus: null,
      sourceExecutionPlanId: null,
      completedAt: new Date(receipt.createdAt),
    },
  };
}

beforeEach(() => {
  userExists = false;
  clientQuery.mockClear();
  clientQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
});

function validPayload(): Record<string, unknown> {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: '2026-06-15T00:00:00.000Z',
    user: {
      id: USER_ID,
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

  it('rejects a hostile non-UUID restored execution plan before any write', async () => {
    const payload = validPayload();
    const bundle = decisionBundle();
    (bundle['ingestState'] as Record<string, unknown>)['sourceExecutionPlanId'] =
      "x'); DROP TABLE users; --";
    payload['decisions'] = [bundle];

    expect(validateBackupData(payload)).toContain(
      'decisions[0].ingestState has inconsistent linkage or classification',
    );
    const result = await restoreBackup(payload);
    expect(result).toMatchObject({ success: false, reason: 'invalid_data' });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('accepts an explicit receipt-free schema-v1 archive', () => {
    const payload = validPayload();
    payload['schemaVersion'] = 1;
    payload['decisions'] = [{
      decision: { id: DECISION_ID, user_id: USER_ID }, candidateActions: [], outcome: null,
      explanations: [{ id: EXPLANATION_ID, decision_id: DECISION_ID }],
    }];
    expect(validateBackupData(payload)).toEqual([]);
  });

  it('keeps schema-v1/v2/v3 fields explicit and fail-safe', () => {
    const current = validPayload();
    current['decisions'] = [{
      decision: { id: DECISION_ID, user_id: USER_ID }, candidateActions: [], outcome: null,
      explanations: [],
    }];
    expect(validateBackupData(current)).toContain(
      `decisions[0].inferenceReceipts is required by schema version ${BACKUP_SCHEMA_VERSION}`,
    );

    const legacy = validPayload();
    legacy['schemaVersion'] = 1;
    legacy['decisions'] = [{
      decision: { id: DECISION_ID, user_id: USER_ID }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [],
    }];
    expect(validateBackupData(legacy)).toContain(
      'decisions[0].inferenceReceipts requires schema version 2',
    );

    const v2 = validPayload();
    v2['schemaVersion'] = 2;
    v2['decisions'] = [{
      decision: { id: DECISION_ID, user_id: USER_ID }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [],
    }];
    expect(validateBackupData(v2)).toEqual([]);

    const v3WithoutState = validPayload();
    v3WithoutState['decisions'] = [{
      decision: { id: DECISION_ID, user_id: USER_ID }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [],
    }];
    expect(validateBackupData(v3WithoutState)).toContain(
      `decisions[0].ingestState is required by schema version ${BACKUP_SCHEMA_VERSION}`,
    );
  });

  it('accepts only sealed receipt snapshots with exact archive linkage', () => {
    const payload = validPayload();
    payload['decisions'] = [decisionBundle()];
    expect(validateBackupData(payload)).toEqual([]);

    const tampered = signedReceipt();
    tampered.model = 'changed-after-signing';
    payload['decisions'] = [decisionBundle(tampered)];
    expect(validateBackupData(payload)).toContain(
      'decisions[0].inferenceReceipts[0] has inconsistent linkage',
    );
  });

  it('accepts UUID linkage when signed and stored values differ only by case', () => {
    const userId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const decisionId = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
    const explanationId = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
    const receiptId = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD';
    const receipt = signedReceipt({
      id: receiptId,
      userId,
      decisionId,
      explanationId,
    });
    const bundle = decisionBundle(receipt);
    const decision = bundle['decision'] as Record<string, unknown>;
    decision['id'] = decisionId.toLowerCase();
    decision['user_id'] = userId.toLowerCase();
    const explanation = (bundle['explanations'] as Array<Record<string, unknown>>)[0]!;
    explanation['id'] = explanationId.toLowerCase();
    explanation['decision_id'] = decisionId.toLowerCase();
    const storedReceipt = (bundle['inferenceReceipts'] as Array<Record<string, unknown>>)[0]!;
    storedReceipt['id'] = receiptId.toLowerCase();
    storedReceipt['decision_id'] = decisionId.toLowerCase();
    storedReceipt['explanation_id'] = explanationId.toLowerCase();
    const ingestState = bundle['ingestState'] as Record<string, unknown>;
    ingestState['decisionId'] = decisionId.toLowerCase();
    ingestState['receiptExplanationId'] = explanationId.toLowerCase();

    const payload = validPayload();
    (payload['user'] as Record<string, unknown>)['id'] = userId.toLowerCase();
    payload['decisions'] = [bundle];

    expect(validateBackupData(payload)).toEqual([]);
  });

  it('rejects more than one receipt for a decision before restore', () => {
    const bundle = decisionBundle();
    const receipt = (bundle['inferenceReceipts'] as Array<Record<string, unknown>>)[0]!;
    bundle['inferenceReceipts'] = [receipt, { ...receipt }];
    const payload = validPayload();
    payload['schemaVersion'] = 2;
    delete bundle['ingestState'];
    payload['decisions'] = [bundle];

    expect(validateBackupData(payload)).toContain(
      'decisions[0].inferenceReceipts must contain at most one receipt',
    );
  });

  it('accepts plural receipts in a schema-v3 decision bundle', () => {
    const bundle = decisionBundle();
    const secondBundle = decisionBundle(signedReceipt({
      id: '55555555-5555-4555-8555-555555555555',
    }));
    (bundle['inferenceReceipts'] as Array<Record<string, unknown>>).push(
      (secondBundle['inferenceReceipts'] as Array<Record<string, unknown>>)[0]!,
    );
    const payload = validPayload();
    payload['decisions'] = [bundle];

    expect(validateBackupData(payload)).toEqual([]);
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

  it('restores an explicit receipt-free schema-v1 archive', async () => {
    const payload = validPayload();
    payload['schemaVersion'] = 1;
    const result = await restoreBackup(payload);
    expect(result.success).toBe(true);
  });

  it('restores legacy decisions with a non-replay tombstone', async () => {
    const payload = validPayload();
    payload['schemaVersion'] = 2;
    payload['decisions'] = [{
      decision: {
        id: DECISION_ID, user_id: USER_ID, situation_type: 'test', raw_event: {},
        interpreted_situation: {}, domain: 'test', urgency: 'normal', metadata: {},
        signal_id: null, created_at: new Date('2026-06-15T00:00:00.000Z'),
      },
      candidateActions: [], outcome: null, explanations: [], inferenceReceipts: [],
    }];

    await expect(restoreBackup(payload)).resolves.toMatchObject({ success: true });
    const guardCall = clientQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO decision_ingest_guards'));
    expect(guardCall?.[1]).toEqual([
      DECISION_ID, null, 'non_effect', null, null, 'ambiguous', null,
      new Date('2026-06-15T00:00:00.000Z'),
    ]);
  });

  it('preserves execution-policy-denial explanation types during restore', async () => {
    const payload = validPayload();
    const bundle = decisionBundle();
    bundle['explanations'] = [{
      id: EXPLANATION_ID,
      decision_id: DECISION_ID,
      type: 'execution_policy_denial',
      what_happened: 'Execution was blocked before dispatch.',
      evidence_used: [],
      preferences_invoked: [],
      confidence_reasoning: 'Policy denied the exact prepared risk.',
      action_rationale: 'No action was taken.',
      escalation_rationale: null,
      correction_guidance: 'Review the policy.',
      capability_provenance_node_id: null,
      created_at: new Date('2026-06-15T00:00:00.000Z'),
    }];
    payload['decisions'] = [bundle];

    await expect(restoreBackup(payload)).resolves.toMatchObject({ success: true });
    const explanationInsert = clientQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO explanation_records'));
    expect(explanationInsert?.[1]?.[2]).toBe('execution_policy_denial');
  });

  it('aborts instead of reporting a receipt whose linkage insert affected no row', async () => {
    const payload = validPayload();
    payload['decisions'] = [decisionBundle()];
    clientQuery.mockImplementation(async (sql: unknown) => ({
      rows: [], rowCount: typeof sql === 'string' && sql.includes('INSERT INTO inference_receipts') ? 0 : 1,
    }));
    await expect(restoreBackup(payload)).rejects.toThrow('could not be linked during restore');
  });
});
