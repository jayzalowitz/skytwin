import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sha256Hex,
  receiptSealPayload,
  signInferenceReceipt,
  snapshotInferenceReceiptExport,
  verifyInferenceReceiptExport,
  type InferenceReceiptExportV1,
} from '../index.js';

const recorder = generateKeyPairSync('ed25519');
const provider = generateKeyPairSync('ed25519');
const pem = (key: typeof recorder.publicKey) => key.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = (key: typeof recorder.privateKey) => key.export({ type: 'pkcs8', format: 'pem' }).toString();

function bundle(): InferenceReceiptExportV1 {
  const request = Buffer.from('{"prompt":"private"}');
  const response = Buffer.from('{"answer":"ok"}');
  const evidence = Buffer.from('{"measurement":"abc"}');
  const unsigned = {
    version: 1 as const,
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    decisionId: '33333333-3333-4333-8333-333333333333',
    explanationId: '44444444-4444-4444-8444-444444444444',
    reasoningMode: 'verified_confidential' as const,
    provider: 'strict-provider', model: 'model-v1', endpointIdentity: 'https://provider.example/v1',
    requestSha256: sha256Hex(request), responseSha256: sha256Hex(response),
    inferenceId: 'inf-1', attestationPolicyVersion: 'policy-1', verifierVersion: 'verifier-1',
    evidenceSha256: sha256Hex(evidence), measurementIdentity: 'measurement-abc',
    responseSignature: {
      algorithm: 'Ed25519' as const, keyId: 'provider-1', publicKeyPem: pem(provider.publicKey),
      signatureBase64: sign(null, response, provider.privateKey).toString('base64'),
    },
    verifiedAt: '2026-09-10T00:00:00.000Z', freshUntil: '2026-09-12T00:00:00.000Z',
    cost: { basis: 'exact' as const, currency: 'USD', amountMinor: 1, billingId: 'bill-1' },
    status: 'verified' as const, createdAt: '2026-09-10T00:00:00.000Z',
  };
  return {
    exportVersion: 1,
    receipt: signInferenceReceipt(unsigned, {
      keyId: 'recorder-1', privateKeyPem: privatePem(recorder.privateKey), publicKeyPem: pem(recorder.publicKey),
    }),
    requestBase64: request.toString('base64'), responseBase64: response.toString('base64'),
    evidenceBase64: evidence.toString('base64'),
    disclosure: 'Contains exact request, response, and minimum verification evidence bytes.',
  };
}

function trustedOptions(now = new Date('2026-09-11')) {
  return {
    now,
    trustedRecorderKeys: new Map([['recorder-1', pem(recorder.publicKey)]]),
    trustedProviderKeys: new Map([['provider-1', pem(provider.publicKey)]]),
    verifyAttestation: () => true,
  };
}

function conventionalBundle(): InferenceReceiptExportV1 {
  const value = bundle();
  const { seal: _seal, attestationPolicyVersion: _policy, evidenceSha256: _evidence,
    measurementIdentity: _measurement, responseSignature: _responseSignature,
    verifiedAt: _verifiedAt, freshUntil: _freshUntil, ...base } = value.receipt;
  delete value.evidenceBase64;
  value.receipt = signInferenceReceipt({
    ...base, reasoningMode: 'conventional_cloud', status: 'conventional', cost: { basis: 'unknown' },
  }, { keyId: 'recorder-1', privateKeyPem: privatePem(recorder.privateKey), publicKeyPem: pem(recorder.publicKey) });
  return value;
}

describe('verifyInferenceReceiptExport', () => {
  it('requires provider trust for a confidential receipt by default', () => {
    expect(verifyInferenceReceiptExport(bundle(), { now: new Date('2026-09-11') })).toMatchObject({
      valid: false, trusted: false, code: 'UNTRUSTED_PROVIDER',
    });
  });

  it('keeps unsupported schema versions distinct from malformed receipts', () => {
    const exportVersion = bundle() as unknown as { exportVersion: number };
    exportVersion.exportVersion = 2;
    expect(verifyInferenceReceiptExport(exportVersion).code).toBe('UNSUPPORTED_VERSION');
    const receiptVersion = bundle() as unknown as { receipt: { version: number } };
    receiptVersion.receipt.version = 2;
    expect(verifyInferenceReceiptExport(receiptVersion).code).toBe('UNSUPPORTED_VERSION');
  });

  it('can explicitly verify confidential receipt integrity without asserting trust', () => {
    expect(verifyInferenceReceiptExport(bundle(), {
      now: new Date('2026-09-11'), integrityOnly: true,
    })).toEqual({
      valid: true, trusted: false, code: 'INTEGRITY_ONLY',
      receiptId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('never promotes integrity-only verification even when the recorder is trusted', () => {
    expect(verifyInferenceReceiptExport(conventionalBundle(), {
      integrityOnly: true,
      trustedRecorderKeys: new Map([['recorder-1', pem(recorder.publicKey)]]),
    })).toMatchObject({ valid: true, trusted: false, code: 'INTEGRITY_ONLY' });
  });

  it('rejects a provider key that is not rooted by the caller', () => {
    const options = trustedOptions();
    options.trustedProviderKeys = new Map();
    expect(verifyInferenceReceiptExport(bundle(), options).code).toBe('UNTRUSTED_PROVIDER');
  });

  it('rejects evidence the configured attestation policy does not accept', () => {
    expect(verifyInferenceReceiptExport(bundle(), { ...trustedOptions(), verifyAttestation: () => false }).code)
      .toBe('ATTESTATION_REJECTED');
  });

  it('verifies exact bytes, response binding, freshness, and the signed metadata', () => {
    expect(verifyInferenceReceiptExport(bundle(), trustedOptions())).toEqual({
      valid: true, trusted: true, code: 'PASS', receiptId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it.each([
    ['requestBase64', 'REQUEST_HASH_MISMATCH'],
    ['responseBase64', 'RESPONSE_HASH_MISMATCH'],
    ['evidenceBase64', 'EVIDENCE_HASH_MISMATCH'],
  ] as const)('rejects tampered %s', (field, code) => {
    const value = bundle();
    value[field] = Buffer.from('tampered').toString('base64');
    expect(verifyInferenceReceiptExport(value).code).toBe(code);
  });

  it.each(['model', 'endpointIdentity', 'decisionId', 'userId', 'fallback', 'cost'] as const)(
    'rejects signed metadata tampering: %s', (field) => {
      const value = bundle();
      Object.assign(value.receipt, { [field]: field === 'cost' ? { basis: 'unknown' } : 'tampered' });
      expect(verifyInferenceReceiptExport(value).code).toBe(field === 'fallback' ? 'INVALID_RECEIPT' : 'SEAL_SIGNATURE_INVALID');
    },
  );

  it('rejects stale verified evidence', () => {
    expect(verifyInferenceReceiptExport(bundle(), trustedOptions(new Date('2026-09-13'))).code).toBe('STALE_VERIFICATION');
  });

  it('treats freshUntil equality as stale', () => {
    expect(verifyInferenceReceiptExport(bundle(), trustedOptions(new Date('2026-09-12T00:00:00.000Z'))).code)
      .toBe('STALE_VERIFICATION');
  });

  it('rejects future-dated and overlong verification windows', () => {
    expect(verifyInferenceReceiptExport(bundle(), trustedOptions(new Date('2026-09-09'))).code).toBe('INVALID_RECEIPT');
    expect(verifyInferenceReceiptExport(bundle(), { ...trustedOptions(), maxVerificationAgeMs: 1 }).code).toBe('INVALID_RECEIPT');
  });

  it('rejects missing required runtime fields even when the reduced object is signed', () => {
    const value = bundle();
    const { seal: _seal, ...unsigned } = value.receipt;
    delete (unsigned as Partial<typeof unsigned>).provider;
    value.receipt = signInferenceReceipt(unsigned, {
      keyId: 'recorder-1', privateKeyPem: privatePem(recorder.privateKey), publicKeyPem: pem(recorder.publicKey),
    });
    expect(verifyInferenceReceiptExport(value, trustedOptions()).code).toBe('INVALID_RECEIPT');
  });

  it('does not permit a conventional inference to claim verified status', () => {
    const value = bundle();
    const { seal: _seal, ...unsigned } = value.receipt;
    value.receipt = signInferenceReceipt({ ...unsigned, reasoningMode: 'conventional_cloud' }, {
      keyId: 'recorder-1', privateKeyPem: privatePem(recorder.privateKey), publicKeyPem: pem(recorder.publicKey),
    });
    expect(verifyInferenceReceiptExport(value).code).toBe('INVALID_RECEIPT');
  });

  it.each([
    ['on_device', 'on_device'], ['verified', 'verified_confidential'],
    ['conventional', 'conventional_cloud'], ['verification_failed', 'verified_confidential'],
    ['verification_unavailable', 'verified_confidential'], ['verification_stale', 'verified_confidential'],
    ['local_fallback', 'on_device'],
  ] as const)('enforces the reasoning-mode matrix for %s', (status, expectedMode) => {
    const value = bundle();
    const { seal: _seal, ...unsigned } = value.receipt;
    value.receipt = signInferenceReceipt({
      ...unsigned, status, reasoningMode: expectedMode === 'on_device' ? 'conventional_cloud' : 'on_device',
    }, { keyId: 'recorder-1', privateKeyPem: privatePem(recorder.privateKey), publicKeyPem: pem(recorder.publicKey) });
    expect(verifyInferenceReceiptExport(value, trustedOptions()).code).toBe('INVALID_RECEIPT');
  });

  it('returns a typed failure instead of throwing on malformed keys', () => {
    const value = bundle();
    value.receipt.seal.publicKeyPem = 'not-a-key';
    expect(verifyInferenceReceiptExport(value)).toEqual({ valid: false, trusted: false, code: 'INVALID_RECEIPT' });
  });

  it.each([
    ['inferenceId', 7], ['attestationPolicyVersion', false], ['evidenceSha256', 3],
    ['measurementIdentity', {}], ['verifiedAt', 4], ['freshUntil', []],
  ] as const)('rejects malformed optional field %s even under a trusted seal', (field, malformed) => {
    const value = conventionalBundle();
    const { seal: _seal, ...unsigned } = value.receipt;
    Object.assign(unsigned, { [field]: malformed });
    value.receipt = signInferenceReceipt(unsigned, {
      keyId: 'recorder-1', privateKeyPem: privatePem(recorder.privateKey), publicKeyPem: pem(recorder.publicKey),
    });
    expect(verifyInferenceReceiptExport(value, trustedOptions()).code).toBe('INVALID_RECEIPT');
  });

  it('rejects amount and currency fields when cost basis is unknown', () => {
    const value = conventionalBundle();
    const { seal: _seal, ...unsigned } = value.receipt;
    value.receipt = signInferenceReceipt({ ...unsigned, cost: { basis: 'unknown', amountMinor: 1 } }, {
      keyId: 'recorder-1', privateKeyPem: privatePem(recorder.privateKey), publicKeyPem: pem(recorder.publicKey),
    });
    expect(verifyInferenceReceiptExport(value, trustedOptions()).code).toBe('INVALID_RECEIPT');
  });

  it.each(['on_device', 'conventional', 'verification_failed', 'verification_unavailable', 'verification_stale', 'local_fallback'] as const)(
    'rejects verified-only metadata on non-verified status %s', (status) => {
      const value = conventionalBundle();
      const { seal: _seal, ...unsigned } = value.receipt;
      const reasoningMode = status === 'on_device' || status === 'local_fallback'
        ? 'on_device' as const
        : status === 'conventional' ? 'conventional_cloud' as const : 'verified_confidential' as const;
      value.receipt = signInferenceReceipt({
        ...unsigned, status, reasoningMode, attestationPolicyVersion: 'misleading-policy',
        ...(status === 'local_fallback'
          ? { fallback: { origin: 'verified_confidential' as const, destination: 'on_device' as const, reason: 'fallback' } }
          : {}),
      }, { keyId: 'recorder-1', privateKeyPem: privatePem(recorder.privateKey), publicKeyPem: pem(recorder.publicKey) });
      expect(verifyInferenceReceiptExport(value, trustedOptions()).code).toBe('INVALID_RECEIPT');
    },
  );

  it.each([
    ['on_device', 'on_device'], ['conventional', 'conventional_cloud'],
    ['verification_failed', 'verified_confidential'], ['verification_unavailable', 'verified_confidential'],
    ['verification_stale', 'verified_confidential'], ['local_fallback', 'on_device'],
  ] as const)('accepts the exact non-verified schema for %s', (status, reasoningMode) => {
    const value = conventionalBundle();
    const { seal: _seal, ...unsigned } = value.receipt;
    value.receipt = signInferenceReceipt({
      ...unsigned, status, reasoningMode,
      ...(status === 'local_fallback'
        ? { fallback: { origin: 'verified_confidential' as const, destination: 'on_device' as const, reason: 'fallback' } }
        : {}),
    }, { keyId: 'recorder-1', privateKeyPem: privatePem(recorder.privateKey), publicKeyPem: pem(recorder.publicKey) });
    expect(verifyInferenceReceiptExport(value, trustedOptions())).toMatchObject({
      valid: true, trusted: true, code: 'PASS',
    });
  });

  it('rejects unknown export members and a malformed disclosure', () => {
    const extra = conventionalBundle() as InferenceReceiptExportV1 & { injected?: boolean };
    extra.injected = true;
    expect(verifyInferenceReceiptExport(extra, trustedOptions()).code).toBe('INVALID_RECEIPT');
    const malformed = conventionalBundle();
    Object.assign(malformed, { disclosure: 7 });
    expect(verifyInferenceReceiptExport(malformed, trustedOptions()).code).toBe('INVALID_RECEIPT');
  });

  it('materializes and deeply freezes one exact-own snapshot', () => {
    const value = bundle();
    const snapshot = snapshotInferenceReceiptExport(value);
    expect(snapshot).not.toBe(value);
    expect(snapshot?.receipt).not.toBe(value.receipt);
    for (const item of [snapshot, snapshot?.receipt, snapshot?.receipt.cost,
      snapshot?.receipt.seal, snapshot?.receipt.responseSignature]) {
      expect(Object.isFrozen(item)).toBe(true);
    }
  });

  it('does not let an attestation verifier mutate signed metadata after the seal check', () => {
    const value = bundle();
    const result = verifyInferenceReceiptExport(value, {
      ...trustedOptions(),
      verifyAttestation: ({ receipt }) => {
        expect(Object.isFrozen(receipt)).toBe(true);
        expect(Reflect.set(receipt, 'model', 'mutated-after-verification')).toBe(false);
        return true;
      },
    });
    expect(result).toMatchObject({ valid: true, trusted: true, code: 'PASS' });
    expect(value.receipt.model).toBe('model-v1');
  });

  it('rejects inherited required fields instead of signing one view and serializing another', () => {
    const value = conventionalBundle();
    const { seal: _seal, provider: _provider, ...ownUnsigned } = value.receipt;
    const inherited = Object.assign(Object.create({ provider: 'strict-provider' }), ownUnsigned);
    const signatureBase64 = sign(null, receiptSealPayload(
      ownUnsigned as Omit<InferenceReceiptExportV1['receipt'], 'seal'>,
    ), recorder.privateKey).toString('base64');
    value.receipt = Object.assign(inherited, { seal: {
      algorithm: 'Ed25519', keyId: 'recorder-1', publicKeyPem: pem(recorder.publicKey), signatureBase64,
    } });
    expect(verifyInferenceReceiptExport(value, trustedOptions()).code).toBe('INVALID_RECEIPT');
  });

  it('rejects accessors, proxies, symbols, and non-enumerable members', () => {
    const accessor = conventionalBundle();
    Object.defineProperty(accessor.receipt, 'provider', { enumerable: true, configurable: true,
      get: () => 'strict-provider' });
    expect(verifyInferenceReceiptExport(accessor, trustedOptions()).code).toBe('INVALID_RECEIPT');

    const proxied = conventionalBundle();
    proxied.receipt = new Proxy(proxied.receipt, {});
    expect(verifyInferenceReceiptExport(proxied, trustedOptions()).code).toBe('INVALID_RECEIPT');

    const symbol = conventionalBundle() as InferenceReceiptExportV1 & { [key: symbol]: string };
    symbol[Symbol('hidden')] = 'value';
    expect(verifyInferenceReceiptExport(symbol, trustedOptions()).code).toBe('INVALID_RECEIPT');

    const hidden = conventionalBundle();
    Object.defineProperty(hidden.receipt, 'hidden', { value: true, enumerable: false });
    expect(verifyInferenceReceiptExport(hidden, trustedOptions()).code).toBe('INVALID_RECEIPT');
  });

  it('matches the RFC 8785 UTF-16 property ordering rule', () => {
    const vector = { '\u20ac': 'Euro', '\r': 'CR', '\ufb33': 'Hebrew', '1': 'One', '\ud83d\ude00': 'Emoji', '\u0080': 'Control', '\u00f6': 'Latin' };
    expect(receiptSealPayload(vector as unknown as Omit<ReturnType<typeof bundle>['receipt'], 'seal'>).toString())
      .toBe('{"\\r":"CR","1":"One","":"Control","ö":"Latin","€":"Euro","😀":"Emoji","דּ":"Hebrew"}');
  });

  it('rejects non-I-JSON lone surrogates in values and property names', () => {
    expect(() => receiptSealPayload(
      { value: '\ud800' } as unknown as Omit<ReturnType<typeof bundle>['receipt'], 'seal'>,
    )).toThrow('lone Unicode surrogate');
    expect(() => receiptSealPayload(
      { ['\udc00']: 'invalid key' } as unknown as Omit<ReturnType<typeof bundle>['receipt'], 'seal'>,
    )).toThrow('lone Unicode surrogate');
  });
});
