import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  policyFromTrustRelease: vi.fn(),
  verifyGatewayAttestation: vi.fn(),
  verifyReceiptKeyAttestation: vi.fn(),
  verifyGatewaySession: vi.fn(),
  verifyReceipt: vi.fn(),
}));

vi.mock('@lore-hex/trusted-router/attestation', () => ({
  EXPORTER_LABEL: 'EXPORTER-Channel-Binding',
  policyFromTrustRelease: sdk.policyFromTrustRelease,
  verifyGatewayAttestation: sdk.verifyGatewayAttestation,
  verifyReceiptKeyAttestation: sdk.verifyReceiptKeyAttestation,
}));
vi.mock('@lore-hex/trusted-router/session', () => ({
  verifyGatewaySession: sdk.verifyGatewaySession,
}));
vi.mock('@lore-hex/trusted-router/receipts', () => ({
  verifyReceipt: sdk.verifyReceipt,
}));

import { generate } from '../providers/trustedrouter.js';

function httpResponse(
  statusCode: number,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Buffer {
  return Buffer.concat([
    Buffer.from([
      `HTTP/1.1 ${statusCode} OK`,
      'Connection: keep-alive',
      `Content-Length: ${body.byteLength}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ].join('\r\n'), 'latin1'),
    Buffer.from(body),
  ]);
}

class ScriptedSocket extends EventEmitter {
  destroyed = false;
  closed = false;
  writable = true;
  readonly writes: Buffer[] = [];

  constructor(private readonly responses: Buffer[]) {
    super();
  }

  setTimeout(): this { return this; }
  pause(): this { return this; }
  resume(): this { return this; }
  unshift(): void {}
  exportKeyingMaterial(): Buffer { return Buffer.alloc(32, 7); }

  write(bytes: Uint8Array, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(bytes));
    const response = this.responses.shift();
    queueMicrotask(() => {
      callback?.(null);
      if (response) this.emit('data', response);
    });
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    this.closed = true;
    this.writable = false;
    return this;
  }
}

function compactReceipt(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const header = Buffer.from(JSON.stringify({
    alg: 'EdDSA',
    typ: 'inference-receipt+jws',
    kid: 'receipt-key',
    jwk,
  })).toString('base64url');
  return `${header}.${Buffer.from('{}').toString('base64url')}.${Buffer.alloc(64, 3).toString('base64url')}`;
}

describe('TrustedRouter confidential provider', () => {
  const receipt = compactReceipt();
  const responseBody = Buffer.from(JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{ message: { content: 'verified answer' } }],
  }));
  let socket: ScriptedSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = new ScriptedSocket([
      httpResponse(200, Buffer.from('gateway-jwt')),
      httpResponse(200, responseBody, { 'X-Inference-Receipt': receipt }),
      httpResponse(200, Buffer.from('receipt-attestation')),
    ]);
    sdk.policyFromTrustRelease.mockResolvedValue({
      audience: 'quill-cloud',
      imageDigest: 'sha256:approved',
      imageReference: null,
    });
    sdk.verifyGatewaySession.mockResolvedValue({
      socket: socket as unknown as TLSSocket,
      exporter: new Uint8Array(32).fill(7),
      leafDer: new Uint8Array([1, 2, 3]),
      attestation: { imageDigest: 'sha256:approved' },
    });
    sdk.verifyGatewayAttestation.mockResolvedValue({ imageDigest: 'sha256:approved' });
    sdk.verifyReceiptKeyAttestation.mockResolvedValue(undefined);
    sdk.verifyReceipt.mockResolvedValue({
      jti: 'chatcmpl-1',
      attestationStatus: 'verified',
      model: {
        requested: 'trustedrouter/confidential',
        selected: 'provider/confidential-model',
        provider: 'provider',
        endpoint: 'endpoint',
      },
      upstream: {
        tier: 'tee-verified',
        policy: 'confidential',
        verifiedAt: 1_780_000_000,
        verificationExpiresAt: 1_780_000_300,
      },
      attSha256: createHash('sha256').update('receipt-attestation').digest('base64url'),
    });
  });

  it('attests, sends, and verifies exact bytes on one pinned TLS socket', async () => {
    const output = await generate('sk-test', 'trustedrouter/confidential', 'hello', {
      temperature: 0,
      maxTokens: 10,
    });

    expect(output.content).toBe('verified answer');
    expect(output.providerRequestId).toBe('chatcmpl-1');
    expect(output.resolvedModel).toBe('provider/confidential-model');
    expect(output.verification.measurementIdentity).toBe('sha256:approved');
    expect(socket.writes).toHaveLength(3);
    expect(socket.writes[0]?.toString('latin1')).toContain('GET /attestation?nonce=');
    expect(socket.writes[1]?.toString('latin1')).toContain('POST /v1/chat/completions HTTP/1.1');
    expect(socket.writes[2]?.toString('latin1')).toContain('GET /receipt-attestation HTTP/1.1');

    const requestBody = socket.writes[1]!.subarray(socket.writes[1]!.indexOf('\r\n\r\n') + 4);
    expect(JSON.parse(requestBody.toString('utf8'))).toMatchObject({
      model: 'trustedrouter/confidential',
      provider: { min_privacy: 'confidential', data_collection: 'deny' },
    });
    expect(sdk.verifyReceipt).toHaveBeenCalledWith(receipt, expect.objectContaining({
      requestBody: expect.any(Uint8Array),
      responseBody: expect.any(Uint8Array),
      expectedNonce: expect.any(String),
      requireAttestation: false,
    }));
    expect(sdk.policyFromTrustRelease).toHaveBeenCalledWith({
      release: {
        image_digest: 'sha256:c3c59c80e645b42e30a652674404405058fe6805fb01ebdc44492d2805a65df5',
        image_reference: 'us-central1-docker.pkg.dev/quill-cloud-proxy/quill/enclave-multi:gcp-release-0ec39d4',
      },
    });
    expect(sdk.verifyReceiptKeyAttestation).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        policy: expect.objectContaining({ imageDigest: 'sha256:approved' }),
        keyCommitmentHex: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(Buffer.from(output.requestBytes)).toEqual(requestBody);
    expect(Buffer.from(output.responseBytes)).toEqual(responseBody);
    expect(socket.destroyed).toBe(true);
  });

  it('returns no provider output when exact-byte receipt verification fails', async () => {
    sdk.verifyReceipt.mockRejectedValueOnce(new Error('response hash mismatch'));

    await expect(generate('sk-test', 'trustedrouter/confidential', 'hello'))
      .rejects.toThrow('response hash mismatch');
    expect(socket.destroyed).toBe(true);
  });

  it('returns no provider output when the receipt key misses the pinned workload policy', async () => {
    sdk.verifyReceiptKeyAttestation.mockRejectedValueOnce(new Error('image digest mismatch'));

    await expect(generate('sk-test', 'trustedrouter/confidential', 'hello'))
      .rejects.toThrow('image digest mismatch');
    expect(socket.destroyed).toBe(true);
  });

  it('rejects receipt attestation bytes that do not match the signed attestation hash', async () => {
    sdk.verifyReceipt.mockResolvedValueOnce({
      attSha256: Buffer.alloc(32).toString('base64url'),
    });

    await expect(generate('sk-test', 'trustedrouter/confidential', 'hello'))
      .rejects.toThrow('attestation hash does not match');
    expect(sdk.verifyReceiptKeyAttestation).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
  });

  it('rejects a successful response without a receipt before parsing content', async () => {
    socket = new ScriptedSocket([
      httpResponse(200, Buffer.from('gateway-jwt')),
      httpResponse(200, responseBody),
    ]);
    sdk.verifyGatewaySession.mockResolvedValue({
      socket: socket as unknown as TLSSocket,
      exporter: new Uint8Array(32).fill(7),
      leafDer: new Uint8Array([1, 2, 3]),
      attestation: { imageDigest: 'sha256:approved' },
    });

    await expect(generate('sk-test', 'trustedrouter/confidential', 'hello'))
      .rejects.toThrow('did not include a signed inference receipt');
    expect(sdk.verifyReceipt).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
  });

  it('sends no prompt if the pinned TLS exporter changes', async () => {
    socket.exportKeyingMaterial = () => Buffer.alloc(32, 9);

    await expect(generate('sk-test', 'trustedrouter/confidential', 'hello'))
      .rejects.toThrow('TLS exporter changed');
    expect(socket.writes).toHaveLength(0);
    expect(socket.destroyed).toBe(true);
  });
});
