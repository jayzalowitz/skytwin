import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock('@skytwin/near-confidential', () => ({
  NEAR_VERIFIER_VERSION: 'near-verifier-test',
  NearConfidentialTransport: class NearConfidentialTransport {
    constructor(readonly options: unknown) {}
  },
  StrictConfidentialClient: class StrictConfidentialClient {
    async generate(request: Uint8Array, policy: unknown) {
      return mocks.generate(request, policy);
    }
  },
}));

import { generate } from '../providers/nearai.js';

const keyPair = generateKeyPairSync('ed25519');
const publicDer = keyPair.publicKey.export({ type: 'spki', format: 'der' });
const signer = publicDer.subarray(publicDer.byteLength - 32).toString('hex');
const measurement = 'd4c89033fb55cdac9db00c775fbbbeff6319fba7249344b2dca99b23ff048479';

describe('NEAR AI confidential provider', () => {
  beforeEach(() => {
    mocks.generate.mockReset();
    mocks.generate.mockImplementation(async (request: Uint8Array) => {
      const response = Buffer.from(JSON.stringify({
        id: 'chat-near-1',
        model: 'deepseek-ai/DeepSeek-V4-Flash',
        choices: [{ message: { content: 'OK' } }],
      }));
      const signedText = [
        'deepseek-ai/DeepSeek-V4-Flash',
        createHash('sha256').update(request).digest('hex'),
        createHash('sha256').update(response).digest('hex'),
      ].join(':');
      return {
        ok: true,
        bytes: response,
        chatId: 'chat-near-1',
        evidence: {
          modelId: 'deepseek-ai/DeepSeek-V4-Flash',
          directEndpoint: 'https://dsv4-flash.completions.near.ai/v1',
          verifiedAt: '2026-09-16T20:00:00.000Z',
          verifierVersion: 'near-verifier-test',
          signingIdentity: signer,
          signatureAlgorithm: 'ed25519',
          signatureProvenance: 'provider_tee',
          tlsSpkiSha256: 'a'.repeat(64),
          sameConnection: true,
          attestation: {
            tdxQuote: new Uint8Array([1, 2]),
            tdxVerified: true,
            tdxStatus: 'OutOfDate',
            gpuEvidence: new Uint8Array([3, 4]),
            gpuVerified: true,
            measurement,
            modelName: 'deepseek-ai/DeepSeek-V4-Flash',
            reportData: {
              scheme: 'sha256(signing_identity||tls_spki_sha256)||nonce',
              signingIdentity: signer,
              tlsSpkiSha256: 'a'.repeat(64),
              nonceHex: 'b'.repeat(64),
            },
          },
        },
        signature: {
          chatId: 'chat-near-1',
          modelId: 'deepseek-ai/DeepSeek-V4-Flash',
          signedText,
          signature: sign(null, Buffer.from(signedText), keyPair.privateKey).toString('hex'),
          signingIdentity: signer,
          algorithm: 'ed25519',
          scheme: 'ed25519-raw',
          signedTextFormat: 'model:request_sha256:response_sha256',
          provenance: 'provider_tee',
        },
      };
    });
  });

  it('buffers output and returns exact signed bytes plus attestation evidence', async () => {
    const output = await generate(
      'near-key',
      'deepseek-ai/DeepSeek-V4-Flash',
      'Respond with exactly: OK',
      { maxTokens: 10, temperature: 0 },
    );

    expect(output.content).toBe('OK');
    expect(output.providerRequestId).toBe('chat-near-1');
    expect(output.endpointIdentity).toBe('https://dsv4-flash.completions.near.ai/v1');
    expect(output.verification).toMatchObject({
      outcome: 'verified',
      measurementIdentity: measurement,
      verifierVersion: 'near-verifier-test',
      responseSignature: {
        algorithm: 'Ed25519',
        keyId: `nearai:${signer}`,
        scheme: 'provider_signed_hashes',
      },
    });
    expect(output.verification.freshUntil).toBe('2026-09-16T20:01:00.000Z');
    const request = JSON.parse(Buffer.from(output.requestBytes).toString('utf8'));
    expect(request).toMatchObject({
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      stream: false,
      messages: [{ role: 'user', content: 'Respond with exactly: OK' }],
    });
  });

  it('rejects unpinned models and verifier failures without content', async () => {
    await expect(generate('near-key', 'other-model', 'hello')).rejects.toThrow(
      'requires deepseek-ai/DeepSeek-V4-Flash',
    );
    mocks.generate.mockResolvedValueOnce({
      ok: false,
      code: 'attestation_invalid',
      message: 'bad quote',
      promptTransmitted: false,
    });
    await expect(generate('near-key', 'deepseek-ai/DeepSeek-V4-Flash', 'hello'))
      .rejects.toThrow('attestation_invalid');
  });
});
