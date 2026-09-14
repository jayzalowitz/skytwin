import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyInferenceReceiptExport } from '@skytwin/shared-types';
import { emitInferenceReceipt } from '../inference-receipt-emitter.js';
import type { InferenceTrace } from '../types.js';

const recorder = generateKeyPairSync('ed25519');
const recorderKey = {
  keyId: 'recorder-1',
  privateKeyPem: recorder.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  publicKeyPem: recorder.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};
const linkage = {
  userId: '11111111-1111-4111-8111-111111111111',
  decisionId: '22222222-2222-4222-8222-222222222222',
  explanationId: '33333333-3333-4333-8333-333333333333',
};

function trace(overrides: Partial<InferenceTrace> = {}): InferenceTrace {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    reasoningMode: 'conventional_cloud', status: 'conventional',
    provider: 'openai', model: 'model', endpointIdentity: 'https://api.openai.com',
    request: Buffer.from('request'), response: Buffer.from('response'),
    cost: { basis: 'unknown' }, createdAt: '2026-09-10T00:00:00.000Z',
    verifierVersion: 'boundary-v1', ...overrides,
  };
}

describe('emitInferenceReceipt', () => {
  it('emits conventional metadata without attestation claims', () => {
    const bundle = emitInferenceReceipt(trace(), linkage, recorderKey);
    expect(bundle.receipt).toMatchObject({
      reasoningMode: 'conventional_cloud', status: 'conventional', cost: { basis: 'unknown' },
    });
    expect(bundle.receipt).not.toHaveProperty('evidenceSha256');
    expect(verifyInferenceReceiptExport(bundle, {
      trustedRecorderKeys: new Map([[recorderKey.keyId, recorderKey.publicKeyPem]]),
    })).toMatchObject({ valid: true, trusted: true, code: 'PASS' });
  });

  it('never allows verified status without a trusted verifier result', () => {
    expect(() => emitInferenceReceipt(trace({
      reasoningMode: 'verified_confidential', status: 'verified',
    }), linkage, recorderKey)).toThrow(/trusted verifier result/);
  });

  it('emits provider-bound attestation fields only for a verified result', () => {
    const provider = generateKeyPairSync('ed25519');
    const providerPublic = provider.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const response = Buffer.from('verified response');
    const evidence = Buffer.from('attestation evidence');
    const bundle = emitInferenceReceipt(trace({
      reasoningMode: 'verified_confidential', status: 'verified', response,
      verifierVersion: 'near-verifier-v1',
      verification: {
        outcome: 'verified', attestationPolicyVersion: 'near-policy-v1',
        verifierVersion: 'near-verifier-v1', evidence, measurementIdentity: 'measurement',
        responseSignature: {
          algorithm: 'Ed25519', keyId: 'near-provider', publicKeyPem: providerPublic,
          signatureBase64: sign(null, response, provider.privateKey).toString('base64'),
        },
        verifiedAt: '2026-09-10T00:00:00.000Z', freshUntil: '2026-09-11T00:00:00.000Z',
      },
    }), linkage, recorderKey);
    const attestationVerifier = vi.fn(() => true);
    expect(verifyInferenceReceiptExport(bundle, {
      now: new Date('2026-09-10T12:00:00.000Z'),
      trustedRecorderKeys: new Map([[recorderKey.keyId, recorderKey.publicKeyPem]]),
      trustedProviderKeys: new Map([['near-provider', providerPublic]]),
      verifyAttestation: attestationVerifier,
    })).toMatchObject({ valid: true, trusted: true, code: 'PASS' });
    expect(attestationVerifier).toHaveBeenCalledOnce();
  });
});
