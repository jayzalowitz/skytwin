import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import {
  EXPORTER_LABEL,
  policyFromTrustRelease,
  verifyGatewayAttestation,
  verifyReceiptKeyAttestation,
  type AttestationPolicy,
} from '@lore-hex/trusted-router/attestation';
import { verifyReceipt } from '@lore-hex/trusted-router/receipts';
import { verifyGatewaySession } from '@lore-hex/trusted-router/session';
import type {
  ChatMessage,
  GenerateOptions,
  VerifiedProviderOutput,
} from '../types.js';
import { toMessages } from '../messages.js';

const BASE_URL = 'https://api.trustedrouter.com/v1';
const HOST = 'api.trustedrouter.com';
const VERIFIER_VERSION = 'trustedrouter-js@2aa1d1c36b758eb65caf6c931e58a82bc0dc53eb';
const PINNED_TRUST_RELEASE = Object.freeze({
  image_digest: 'sha256:c3c59c80e645b42e30a652674404405058fe6805fb01ebdc44492d2805a65df5',
  image_reference: 'us-central1-docker.pkg.dev/quill-cloud-proxy/quill/enclave-multi:gcp-release-0ec39d4',
});
const RECEIPT_KEY_COMMITMENT_DOMAIN = Buffer.from('inference-receipt-key-v1\0', 'utf8');
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

interface HttpResponseBytes {
  statusCode: number;
  headers: ReadonlyMap<string, string>;
  body: Uint8Array;
}

function assertHeaderValue(value: string, name: string): void {
  if (/[^\x20-\x7e]/.test(value)) {
    throw new Error(`${name} contains characters that are unsafe in an HTTP header`);
  }
}

function parseHeaders(raw: string): {
  statusCode: number;
  headers: Map<string, string>;
} {
  const lines = raw.split('\r\n');
  const status = /^HTTP\/1\.[01] ([0-9]{3})(?: .*)?$/.exec(lines.shift() ?? '');
  if (!status) throw new Error('TrustedRouter returned an invalid HTTP status line');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('TrustedRouter returned a malformed HTTP header');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name)) {
      throw new Error(`TrustedRouter returned duplicate ${name} headers`);
    }
    headers.set(name, value);
  }
  return { statusCode: Number(status[1]), headers };
}

function parseChunkedBody(
  bytes: Buffer,
  bodyStart: number,
  maxBodyBytes: number,
): { body: Buffer; end: number } | null {
  const chunks: Buffer[] = [];
  let total = 0;
  let offset = bodyStart;
  while (true) {
    const lineEnd = bytes.indexOf('\r\n', offset, 'latin1');
    if (lineEnd < 0) return null;
    const sizeText = bytes.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0] ?? '';
    if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error('TrustedRouter returned invalid chunk framing');
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size)) throw new Error('TrustedRouter returned an oversized chunk');
    offset = lineEnd + 2;
    if (size === 0) {
      const trailerEnd = bytes.indexOf('\r\n\r\n', offset, 'latin1');
      if (trailerEnd >= 0) return { body: Buffer.concat(chunks, total), end: trailerEnd + 4 };
      // A zero chunk with no trailers is terminated by one final CRLF.
      if (bytes.length >= offset + 2 && bytes.subarray(offset, offset + 2).equals(Buffer.from('\r\n'))) {
        return { body: Buffer.concat(chunks, total), end: offset + 2 };
      }
      return null;
    }
    if (total + size > maxBodyBytes) throw new Error('TrustedRouter response exceeded its byte limit');
    if (bytes.length < offset + size + 2) return null;
    if (!bytes.subarray(offset + size, offset + size + 2).equals(Buffer.from('\r\n'))) {
      throw new Error('TrustedRouter returned invalid chunk framing');
    }
    chunks.push(bytes.subarray(offset, offset + size));
    total += size;
    offset += size + 2;
  }
}

function tryParseResponse(
  bytes: Buffer,
  maxBodyBytes: number,
): { response: HttpResponseBytes; rest: Buffer } | null {
  const headerEnd = bytes.indexOf('\r\n\r\n', 0, 'latin1');
  if (headerEnd < 0) {
    if (bytes.length > MAX_HEADER_BYTES) throw new Error('TrustedRouter response headers exceeded their byte limit');
    return null;
  }
  if (headerEnd > MAX_HEADER_BYTES) throw new Error('TrustedRouter response headers exceeded their byte limit');
  const { statusCode, headers } = parseHeaders(bytes.subarray(0, headerEnd).toString('latin1'));
  const connection = headers.get('connection')?.toLowerCase();
  if (connection?.split(',').some((token) => token.trim() === 'close')) {
    throw new Error('TrustedRouter closed the attested TLS connection before verification completed');
  }
  if (headers.has('content-encoding')) {
    throw new Error('TrustedRouter returned an encoded body whose exact receipt subject is ambiguous');
  }
  const bodyStart = headerEnd + 4;
  const transferEncoding = headers.get('transfer-encoding')?.toLowerCase();
  let parsedBody: { body: Buffer; end: number } | null;
  if (transferEncoding === 'chunked') {
    parsedBody = parseChunkedBody(bytes, bodyStart, maxBodyBytes);
  } else {
    if (transferEncoding) throw new Error('TrustedRouter returned an unsupported transfer encoding');
    const rawLength = headers.get('content-length');
    if (rawLength === undefined || !/^[0-9]+$/.test(rawLength)) {
      throw new Error('TrustedRouter response did not provide a valid Content-Length');
    }
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length > maxBodyBytes) {
      throw new Error('TrustedRouter response exceeded its byte limit');
    }
    if (bytes.length < bodyStart + length) return null;
    parsedBody = { body: bytes.subarray(bodyStart, bodyStart + length), end: bodyStart + length };
  }
  if (!parsedBody) return null;
  return {
    response: {
      statusCode,
      headers,
      body: Uint8Array.from(parsedBody.body),
    },
    rest: bytes.subarray(parsedBody.end),
  };
}

async function requestOnVerifiedSocket(
  socket: TLSSocket,
  input: {
    method: 'GET' | 'POST';
    path: string;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
    timeoutMs: number;
    maxBodyBytes?: number;
  },
): Promise<HttpResponseBytes> {
  if (socket.destroyed || socket.closed || !socket.writable) {
    throw new Error('The verified TrustedRouter TLS connection is no longer available');
  }
  const body = input.body ? Buffer.from(input.body) : Buffer.alloc(0);
  const headers = {
    Host: HOST,
    Connection: 'keep-alive',
    Accept: 'application/json',
    ...input.headers,
    'Content-Length': String(body.byteLength),
  };
  for (const [name, value] of Object.entries(headers)) assertHeaderValue(value, name);
  const head = Buffer.from([
    `${input.method} ${input.path} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n'), 'ascii');

  return new Promise((resolve, reject) => {
    let received: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('timeout', onTimeout);
      socket.setTimeout(0);
    };
    const finish = (error?: Error, response?: HttpResponseBytes, rest: Uint8Array = new Uint8Array()) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.pause();
      if (rest.byteLength > 0) socket.unshift(Buffer.from(rest));
      if (error) reject(error);
      else resolve(response!);
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.byteLength > (input.maxBodyBytes ?? MAX_BODY_BYTES) + MAX_HEADER_BYTES + 1024) {
        finish(new Error('TrustedRouter response exceeded its byte limit'));
        return;
      }
      try {
        const parsed = tryParseResponse(received, input.maxBodyBytes ?? MAX_BODY_BYTES);
        if (parsed) finish(undefined, parsed.response, parsed.rest);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error('TrustedRouter ended the verified TLS connection early'));
    const onTimeout = () => finish(new Error('TrustedRouter request timed out'));
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
    socket.once('timeout', onTimeout);
    socket.setTimeout(input.timeoutMs);
    socket.resume();
    socket.write(Buffer.concat([head, body]), (error?: Error | null) => {
      if (error) finish(error);
    });
  });
}

function receiptSigningKey(receipt: string): { keyId: string; rawKey: Buffer } {
  const parts = receipt.split('.');
  if (parts.length !== 3) throw new Error('TrustedRouter returned a malformed compact receipt');
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as {
    kid?: unknown;
    jwk?: { kty?: unknown; crv?: unknown; x?: unknown };
  };
  if (typeof header.kid !== 'string'
      || header.jwk?.kty !== 'OKP'
      || header.jwk.crv !== 'Ed25519'
      || typeof header.jwk.x !== 'string') {
    throw new Error('TrustedRouter receipt omitted its verified signing identity');
  }
  const rawKey = Buffer.from(header.jwk.x, 'base64url');
  if (rawKey.byteLength !== 32) throw new Error('TrustedRouter receipt signing key is malformed');
  return { keyId: header.kid, rawKey };
}

function responseSignature(receipt: string) {
  const { keyId, rawKey } = receiptSigningKey(receipt);
  const parts = receipt.split('.');
  const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const key = createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, rawKey]),
    format: 'der',
    type: 'spki',
  });
  const publicKeyPem = key.export({ type: 'spki', format: 'pem' }).toString();
  return {
    algorithm: 'Ed25519' as const,
    keyId,
    publicKeyPem,
    signatureBase64: Buffer.from(parts[2]!, 'base64url').toString('base64'),
    scheme: 'jws_signing_input' as const,
    signedPayloadBase64: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii').toString('base64'),
  };
}

function evidenceBundle(input: {
  gatewayAttestation: Uint8Array;
  receiptAttestation: Uint8Array;
  receipt: string;
}): Uint8Array {
  const bytes = Buffer.from(JSON.stringify({
    version: 1,
    verifier: VERIFIER_VERSION,
    gatewayAttestationBase64: Buffer.from(input.gatewayAttestation).toString('base64'),
    receiptAttestationBase64: Buffer.from(input.receiptAttestation).toString('base64'),
    receipt: input.receipt,
  }), 'utf8');
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error('TrustedRouter verification evidence exceeded its byte limit');
  return bytes;
}

async function captureGatewayEvidence(
  socket: TLSSocket,
  policy: AttestationPolicy,
  session: Awaited<ReturnType<typeof verifyGatewaySession>>,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; imageDigest: string }> {
  const exportWithoutContext = socket.exportKeyingMaterial.bind(socket) as (
    length: number,
    label: string,
  ) => Buffer;
  const liveExporter = exportWithoutContext(session.exporter.byteLength, EXPORTER_LABEL);
  if (!Buffer.from(liveExporter).equals(Buffer.from(session.exporter))) {
    throw new Error('TrustedRouter TLS exporter changed before prompt transmission');
  }
  const nonceHex = randomBytes(32).toString('hex');
  const response = await requestOnVerifiedSocket(socket, {
    method: 'GET',
    path: `/attestation?nonce=${nonceHex}`,
    timeoutMs,
    maxBodyBytes: MAX_EVIDENCE_BYTES,
  });
  if (response.statusCode !== 200) throw new Error(`TrustedRouter attestation failed with HTTP ${response.statusCode}`);
  const verified = await verifyGatewayAttestation(response.body, {
    policy,
    nonceHex,
    tlsCertDer: session.leafDer,
    tlsExporter: liveExporter,
  });
  return { bytes: response.body, imageDigest: verified.imageDigest };
}

/**
 * Confidential requests are buffered and released only after both the live
 * same-socket gateway attestation and exact-byte inference receipt verify.
 */
export async function generate(
  apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions = {},
): Promise<VerifiedProviderOutput> {
  if (!apiKey) throw new Error('TrustedRouter API key is required');
  assertHeaderValue(apiKey, 'TrustedRouter API key');
  const timeoutMs = options.timeoutMs ?? 120_000;
  const inputMessages = toMessages(prompt);
  const hasInlineSystem = inputMessages.some((message) => message.role === 'system');
  const messages: ChatMessage[] = [];
  if (options.systemPrompt && !hasInlineSystem) messages.push({ role: 'system', content: options.systemPrompt });
  messages.push(...inputMessages);
  const requestBytes = Buffer.from(JSON.stringify({
    model: model || 'trustedrouter/confidential',
    messages,
    max_tokens: options.maxTokens ?? 1024,
    temperature: options.temperature ?? 0.3,
    provider: {
      min_privacy: 'confidential',
      data_collection: 'deny',
    },
  }), 'utf8');
  if (requestBytes.byteLength > 1024 * 1024) throw new Error('TrustedRouter request exceeded its byte limit');

  // The workload allowlist is part of this SkyTwin build. Do not turn a live,
  // provider-controlled trust document into the root of trust at call time.
  const policy = await policyFromTrustRelease({ release: PINNED_TRUST_RELEASE });
  const session = await verifyGatewaySession({ baseUrl: BASE_URL, policy, timeoutMs });
  try {
    const gatewayEvidence = await captureGatewayEvidence(session.socket, policy, session, timeoutMs);
    const receiptNonce = randomBytes(24).toString('base64url');
    const response = await requestOnVerifiedSocket(session.socket, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Inference-Receipt': receiptNonce,
      },
      body: requestBytes,
      timeoutMs,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`TrustedRouter inference failed with HTTP ${response.statusCode}`);
    }
    const receipt = response.headers.get('x-inference-receipt');
    if (!receipt) throw new Error('TrustedRouter response did not include a signed inference receipt');
    const receiptAttestation = await requestOnVerifiedSocket(session.socket, {
      method: 'GET',
      path: '/receipt-attestation',
      timeoutMs,
      maxBodyBytes: MAX_EVIDENCE_BYTES,
    });
    if (receiptAttestation.statusCode !== 200) {
      throw new Error(`TrustedRouter receipt attestation failed with HTTP ${receiptAttestation.statusCode}`);
    }
    const claims = await verifyReceipt(receipt, {
      expectedIssuer: 'https://api.trustedrouter.com',
      requestBody: requestBytes,
      responseBody: response.body,
      expectedNonce: receiptNonce,
      maxAgeSeconds: 300,
      // The SDK's default attestation path fetches a live provider allowlist.
      // Verify the receipt bindings here, then bind and verify the supplied
      // attestation ourselves against the SkyTwin-pinned policy below.
      requireAttestation: false,
    });
    const receiptAttestationSha256 = createHash('sha256')
      .update(receiptAttestation.body)
      .digest('base64url');
    if (claims.attSha256 !== receiptAttestationSha256) {
      throw new Error('TrustedRouter receipt attestation hash does not match the signed receipt');
    }
    const { rawKey } = receiptSigningKey(receipt);
    const keyCommitmentHex = createHash('sha256')
      .update(RECEIPT_KEY_COMMITMENT_DOMAIN)
      .update(rawKey)
      .digest('hex');
    // The upstream SDK verifies receipt-key attestation against its live trust
    // release internally. Repeat that verification against SkyTwin's pinned
    // policy so a trust-page update cannot silently widen this build's policy.
    await verifyReceiptKeyAttestation(receiptAttestation.body, {
      policy,
      keyCommitmentHex,
    });
    if (claims.upstream.tier !== 'tee-verified' || claims.attestationStatus !== 'verified') {
      throw new Error('TrustedRouter receipt did not prove a confidential upstream route');
    }
    if (claims.model.requested !== (model || 'trustedrouter/confidential')) {
      throw new Error('TrustedRouter receipt model does not match the requested model');
    }
    const parsed = JSON.parse(Buffer.from(response.body).toString('utf8')) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('TrustedRouter returned no text completion');
    const verifiedAt = new Date(claims.upstream.verifiedAt! * 1000).toISOString();
    const freshUntil = new Date(claims.upstream.verificationExpiresAt! * 1000).toISOString();
    return Object.freeze({
      content,
      requestBytes: Uint8Array.from(requestBytes),
      responseBytes: Uint8Array.from(response.body),
      endpointIdentity: BASE_URL,
      providerRequestId: claims.jti,
      resolvedModel: claims.model.selected,
      verification: Object.freeze({
        outcome: 'verified' as const,
        inferenceId: claims.jti,
        attestationPolicyVersion: `trustedrouter-gcp:${gatewayEvidence.imageDigest}`,
        verifierVersion: VERIFIER_VERSION,
        evidence: evidenceBundle({
          gatewayAttestation: gatewayEvidence.bytes,
          receiptAttestation: receiptAttestation.body,
          receipt,
        }),
        measurementIdentity: gatewayEvidence.imageDigest,
        responseSignature: responseSignature(receipt),
        verifiedAt,
        freshUntil,
      }),
    });
  } finally {
    session.socket.destroy();
  }
}
