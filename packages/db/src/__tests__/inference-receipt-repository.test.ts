import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, signInferenceReceipt, type InferenceReceiptExportV1 } from '@skytwin/shared-types';

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

describe('inferenceReceiptRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an untrusted self-signed receipt before querying the database', async () => {
    const result = await inferenceReceiptRepository.createForUser('user', {
      bundle: fixture(), trustedRecorderKeys: new Map(),
    });
    expect(result).toBeNull();
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
    expect(await inferenceReceiptRepository.createForUser(value.receipt.userId, {
      bundle: value, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    })).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('derives ownership by joining the decision and explanation', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'receipt-row' }], rowCount: 1 });
    const bundle = fixture();
    await inferenceReceiptRepository.createForUser(bundle.receipt.userId, {
      bundle, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    });
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('JOIN explanation_records er ON er.decision_id = d.id');
    expect(sql).toContain('WHERE d.user_id = $1');
    expect(sql).toContain('$7::JSONB, true');
    expect(args[0]).toBe(bundle.receipt.userId);
    expect(args[7]).toBe(bundle.receipt.userId);
  });

  it('returns null when linked rows do not belong to the authenticated user', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const bundle = fixture();
    expect(await inferenceReceiptRepository.createForUser('another-user', {
      bundle, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    })).toBeNull();
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
    ], { decisionId: trusted.receipt.decisionId, explanationId: trusted.receipt.explanationId })).toBeNull();
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
      { decisionId: unsigned.decisionId, explanationId: unsigned.explanationId },
    )).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockTransactionQuery).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('fails the transaction when any receipt cannot link to the owned explanation', async () => {
    mockTransactionQuery
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
    })), { decisionId: first.receipt.decisionId, explanationId: first.receipt.explanationId })).rejects.toThrow(/linkage/);
  });

  it('writes a completion marker in the same transaction even when no call completed', async () => {
    mockTransactionQuery.mockResolvedValue({ rows: [{ decision_id: 'decision' }], rowCount: 1 });
    const rows = await inferenceReceiptRepository.createManyForUser('user', [], {
      decisionId: 'decision', explanationId: 'explanation',
    });
    expect(rows).toEqual([]);
    expect(mockTransactionQuery).toHaveBeenCalledOnce();
    expect(mockTransactionQuery.mock.calls[0]![0]).toContain('inference_receipt_completions');
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
