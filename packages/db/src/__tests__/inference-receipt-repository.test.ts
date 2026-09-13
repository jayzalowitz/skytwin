import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, signInferenceReceipt, type InferenceReceiptExportV1 } from '@skytwin/shared-types';
import type { InferenceReceiptCompletionLinkage } from '../repositories/inference-receipt-repository.js';

const mockQuery = vi.fn();
const mockTransactionQuery = vi.fn();
const mockWithTransaction = vi.fn(
  (fn: (client: { query: typeof mockTransactionQuery }) => Promise<unknown>) =>
    fn({ query: mockTransactionQuery }),
);
vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (fn: (client: { query: typeof mockTransactionQuery }) => Promise<unknown>) =>
    mockWithTransaction(fn),
}));
const { inferenceReceiptRepository } = await import('../repositories/inference-receipt-repository.js');

const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function fixture(): InferenceReceiptExportV1 {
  const request = Buffer.from('request');
  const response = Buffer.from('response');
  return {
    exportVersion: 1,
    receipt: signInferenceReceipt({
      version: 1, id: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      decisionId: '33333333-3333-4333-8333-333333333333',
      explanationId: '44444444-4444-4444-8444-444444444444',
      reasoningMode: 'conventional_cloud', provider: 'provider', model: 'model',
      endpointIdentity: 'https://provider.example', requestSha256: sha256Hex(request),
      responseSha256: sha256Hex(response), verifierVersion: '1', cost: { basis: 'unknown' },
      status: 'conventional', createdAt: '2026-09-10T00:00:00.000Z',
    }, { keyId: 'recorder', privateKeyPem, publicKeyPem }),
    requestBase64: request.toString('base64'), responseBase64: response.toString('base64'),
    disclosure: 'Exact request and response bytes are included for independent verification.',
  };
}

function completionFor(
  bundle: InferenceReceiptExportV1,
  continuationKind: 'auto_execute' | 'approval' | 'non_effect' = 'non_effect',
): InferenceReceiptCompletionLinkage {
  return {
    decisionId: bundle.receipt.decisionId,
    explanationId: bundle.receipt.explanationId,
    continuationKind,
    confirmationLevel: continuationKind === 'approval' ? 'dual' : null,
  };
}

describe('inferenceReceiptRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an untrusted self-signed receipt before querying the database', async () => {
    const bundle = fixture();
    const result = await inferenceReceiptRepository.createManyForUser(bundle.receipt.userId, [{
      bundle, trustedRecorderKeys: new Map(),
    }], completionFor(bundle));
    expect(result).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('cannot persist verified status without provider trust and an attestation verifier', async () => {
    const value = fixture();
    const response = Buffer.from('response');
    const evidence = Buffer.from('evidence');
    const { seal: _seal, ...base } = value.receipt;
    value.evidenceBase64 = evidence.toString('base64');
    value.receipt = signInferenceReceipt({
      ...base, reasoningMode: 'verified_confidential', status: 'verified',
      evidenceSha256: sha256Hex(evidence), attestationPolicyVersion: 'policy-1',
      measurementIdentity: 'measurement-1', verifiedAt: '2026-09-10T00:00:00.000Z',
      freshUntil: '2026-09-11T00:00:00.000Z',
      responseSignature: { algorithm: 'Ed25519', keyId: 'provider', publicKeyPem,
        signatureBase64: sign(null, response, keys.privateKey).toString('base64') },
    }, { keyId: 'recorder', privateKeyPem, publicKeyPem });
    expect(await inferenceReceiptRepository.createManyForUser(value.receipt.userId, [{
      bundle: value, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    }], completionFor(value))).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('derives batch ownership from the locked decision and explanation', async () => {
    const bundle = fixture();
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [{ id: bundle.receipt.decisionId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: bundle.receipt.id }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ decision_id: bundle.receipt.decisionId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ decision_id: bundle.receipt.decisionId }], rowCount: 1 });
    await inferenceReceiptRepository.createManyForUser(bundle.receipt.userId, [{
      bundle, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    }], completionFor(bundle));
    const [sql, args] = mockTransactionQuery.mock.calls[2]!;
    expect(sql).toContain('JOIN explanation_records er ON er.decision_id = d.id');
    expect(sql).toContain('WHERE d.user_id = $1');
    expect(sql).toContain('$7::JSONB, true');
    expect(sql).toContain('version::INT4 AS version');
    expect(args[0]).toBe(bundle.receipt.userId);
    expect(args[7]).toBe(bundle.receipt.userId);
  });

  it('rejects the batch when the locked linkage is not owned', async () => {
    mockTransactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const bundle = fixture();
    await expect(inferenceReceiptRepository.createManyForUser(bundle.receipt.userId, [{
      bundle, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    }], completionFor(bundle))).rejects.toThrow(/linkage/);
  });

  it('validates every bundle before opening the atomic batch transaction', async () => {
    const trusted = fixture();
    const untrusted = fixture();
    const { seal: _seal, ...unsigned } = untrusted.receipt;
    const attacker = generateKeyPairSync('ed25519');
    untrusted.receipt = signInferenceReceipt(unsigned, {
      keyId: 'attacker',
      privateKeyPem: attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKeyPem: attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    expect(await inferenceReceiptRepository.createManyForUser(trusted.receipt.userId, [
      { bundle: trusted, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]) },
      { bundle: untrusted, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]) },
    ], completionFor(trusted))).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockTransactionQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['userId', 'another-user', undefined, undefined],
    ['decisionId', undefined, '55555555-5555-4555-8555-555555555555', undefined],
    ['explanationId', undefined, undefined, '66666666-6666-4666-8666-666666666666'],
  ] as const)('rejects a bundle with mismatched %s before opening a transaction', async (
    _field,
    userId,
    decisionId,
    explanationId,
  ) => {
    const bundle = fixture();
    const { seal: _seal, ...unsigned } = bundle.receipt;
    bundle.receipt = signInferenceReceipt({
      ...unsigned,
      userId: userId ?? unsigned.userId,
      decisionId: decisionId ?? unsigned.decisionId,
      explanationId: explanationId ?? unsigned.explanationId,
    }, { keyId: 'recorder', privateKeyPem, publicKeyPem });

    expect(await inferenceReceiptRepository.createManyForUser(
      unsigned.userId,
      [{ bundle, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]) }],
      {
        decisionId: unsigned.decisionId,
        explanationId: unsigned.explanationId,
        continuationKind: 'non_effect',
        confirmationLevel: null,
      },
    )).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockTransactionQuery).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('fails the transaction when any receipt cannot link to the owned explanation', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [{ id: 'decision' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'first' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const first = fixture();
    const second = fixture();
    const { seal: _seal, ...unsigned } = second.receipt;
    second.receipt = signInferenceReceipt({
      ...unsigned, id: '55555555-5555-4555-8555-555555555555',
    }, { keyId: 'recorder', privateKeyPem, publicKeyPem });
    await expect(inferenceReceiptRepository.createManyForUser(first.receipt.userId, [first, second].map((bundle) => ({
      bundle, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    })), completionFor(first))).rejects.toThrow(/linkage/);
  });

  it('writes a completion marker in the same transaction even when no call completed', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [{ id: 'decision' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ decision_id: 'decision' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ decision_id: 'decision' }], rowCount: 1 });
    const rows = await inferenceReceiptRepository.createManyForUser('user', [], {
      decisionId: 'decision', explanationId: 'explanation',
      continuationKind: 'auto_execute', confirmationLevel: null,
    });
    expect(rows).toEqual([]);
    expect(mockTransactionQuery).toHaveBeenCalledTimes(4);
    expect(mockTransactionQuery.mock.calls[0]![0]).toContain('FOR UPDATE OF d');
    expect(mockTransactionQuery.mock.calls[2]![0]).toContain('inference_receipt_completions');
    expect(mockTransactionQuery.mock.calls[3]![0]).toContain('decision_ingest_guards');
    expect(mockTransactionQuery.mock.calls[3]![1].slice(3)).toEqual(['auto_execute', null, 'ready']);
  });

  it('rejects a second capture after serializing on an existing completion', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [{ id: 'decision' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ explanation_id: 'explanation' }], rowCount: 1 });

    await expect(inferenceReceiptRepository.createManyForUser('user', [], {
      decisionId: 'decision', explanationId: 'explanation',
      continuationKind: 'non_effect', confirmationLevel: null,
    })).rejects.toThrow(/already finalized/);

    expect(mockTransactionQuery).toHaveBeenCalledTimes(2);
  });

  it('persists the batch snapshot that passed trust verification', async () => {
    const bundle = fixture();
    const completion = completionFor(bundle);
    const hostileTrustMap = { get: () => {
      bundle.receipt.model = 'changed-during-trust-lookup';
      completion.continuationKind = 'auto_execute';
      completion.confirmationLevel = null;
      return publicKeyPem;
    } } as unknown as ReadonlyMap<string, string>;
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [{ id: bundle.receipt.decisionId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: bundle.receipt.id }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ decision_id: bundle.receipt.decisionId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ decision_id: bundle.receipt.decisionId }], rowCount: 1 });

    await inferenceReceiptRepository.createManyForUser(bundle.receipt.userId, [{
      bundle,
      trustedRecorderKeys: hostileTrustMap,
    }], completion);

    const receiptInsertArgs = mockTransactionQuery.mock.calls[2]![1] as unknown[];
    expect(JSON.parse(receiptInsertArgs[6] as string)).toMatchObject({ model: 'model' });
    expect(bundle.receipt.model).toBe('changed-during-trust-lookup');
    expect(mockTransactionQuery.mock.calls[4]![1].slice(3)).toEqual(['non_effect', null, 'non_effect']);
  });

  it('reads the owner-scoped guard and claims ready execution only once', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        receipt_capture_complete: true,
        receipt_explanation_id: 'explanation',
        continuation_kind: 'auto_execute',
        confirmation_level: null,
        effect_state: 'ready',
        source_effect_state: null,
        source_execution_status: null,
        source_execution_plan_id: null,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ decision_id: 'decision' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(inferenceReceiptRepository.getIngestStateForDecision('user', 'decision'))
      .resolves.toMatchObject({ effectState: 'ready', continuationKind: 'auto_execute' });
    await expect(inferenceReceiptRepository.claimExecutionForDecision('user', 'decision'))
      .resolves.toBe(true);
    await expect(inferenceReceiptRepository.claimExecutionForDecision('user', 'decision'))
      .resolves.toBe(false);
    expect(mockQuery.mock.calls[1]![0]).toContain("g.effect_state = 'ready'");
    expect(mockQuery.mock.calls[1]![0]).toContain('d.user_id = $1');
  });

  it('classifies a legacy completion without a guard as restored and non-replayable', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ explanation_id: 'explanation' }], rowCount: 1 });

    await expect(inferenceReceiptRepository.getIngestStateForDecision('user', 'decision'))
      .resolves.toEqual({
        receiptCaptureComplete: true,
        receiptExplanationId: 'explanation',
        continuationKind: 'auto_execute',
        confirmationLevel: null,
        effectState: 'restored_non_replay',
        sourceEffectState: null,
        sourceExecutionStatus: 'ambiguous',
        sourceExecutionPlanId: null,
      });
  });

  it('marks only an owned running execution terminal', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ decision_id: 'decision' }], rowCount: 1 });
    await expect(inferenceReceiptRepository.markExecutionTerminalForDecision(
      'user', 'decision', 'failed', 'plan',
    )).resolves.toBe(true);
    expect(mockQuery.mock.calls[0]![0]).toContain("g.effect_state = 'running'");
    expect(mockQuery.mock.calls[0]![1]).toEqual(['user', 'decision', 'failed', 'plan']);
  });

  it('scopes reads and deletion through the decision owner', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await inferenceReceiptRepository.findByIdForUser('user', 'receipt');
    await inferenceReceiptRepository.listForUser('user');
    await inferenceReceiptRepository.deleteForUser('user', 'receipt');
    for (const call of mockQuery.mock.calls) {
      expect(call[0]).toContain('d.user_id = $1');
      expect(call[1][0]).toBe('user');
    }
  });
});
