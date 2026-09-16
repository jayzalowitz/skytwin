import { createPublicKey } from 'node:crypto';
import {
  NearConfidentialTransport,
  NEAR_VERIFIER_VERSION,
  StrictConfidentialClient,
  type AttestationPolicy,
  type NormalizedResponseSignatureRecord,
  type VerifiedChannelEvidence,
} from '@skytwin/near-confidential';
import type {
  ChatMessage,
  GenerateOptions,
  VerifiedProviderOutput,
} from '../types.js';
import { toMessages } from '../messages.js';

const MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const ENDPOINT = 'https://dsv4-flash.completions.near.ai/v1';
const APPROVED_COMPOSE_HASH = 'd4c89033fb55cdac9db00c775fbbbeff6319fba7249344b2dca99b23ff048479';
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const POLICY: AttestationPolicy = Object.freeze({
  modelId: MODEL,
  directEndpoint: ENDPOINT,
  approvedMeasurements: Object.freeze([APPROVED_COMPOSE_HASH]),
  maxAgeMs: 60_000,
  verifierVersion: NEAR_VERIFIER_VERSION,
  signatureAlgorithm: 'ed25519',
  signatureProvenance: 'provider_tee',
});

function signatureBytes(value: string): Buffer {
  if (/^[a-f0-9]{128}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.byteLength === 64) return decoded;
  }
  throw new Error('NEAR AI returned a malformed Ed25519 signature');
}

function responseSignature(signature: NormalizedResponseSignatureRecord) {
  const rawKey = Buffer.from(signature.signingIdentity, 'hex');
  if (rawKey.byteLength !== 32) throw new Error('NEAR AI attested signing key is malformed');
  const publicKeyPem = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: 'der',
    type: 'spki',
  }).export({ type: 'spki', format: 'pem' }).toString();
  return {
    algorithm: 'Ed25519' as const,
    keyId: `nearai:${signature.signingIdentity}`,
    publicKeyPem,
    signatureBase64: signatureBytes(signature.signature).toString('base64'),
    scheme: 'provider_signed_hashes' as const,
    signedPayloadBase64: Buffer.from(signature.signedText, 'utf8').toString('base64'),
  };
}

function evidenceBundle(
  evidence: VerifiedChannelEvidence,
  signature: NormalizedResponseSignatureRecord,
): Uint8Array {
  const bytes = Buffer.from(JSON.stringify({
    version: 1,
    verifier: NEAR_VERIFIER_VERSION,
    policy: {
      endpoint: ENDPOINT,
      model: MODEL,
      approvedComposeHash: APPROVED_COMPOSE_HASH,
      acceptedTdxStatuses: ['UpToDate', 'OutOfDate'],
    },
    channel: {
      verifiedAt: evidence.verifiedAt,
      signingIdentity: evidence.signingIdentity,
      tlsSpkiSha256: evidence.tlsSpkiSha256,
      measurement: evidence.attestation.measurement,
      tdxStatus: evidence.attestation.tdxStatus,
      nonceHex: evidence.attestation.reportData.nonceHex,
      tdxQuoteBase64: Buffer.from(evidence.attestation.tdxQuote).toString('base64'),
      gpuEvidenceBase64: Buffer.from(evidence.attestation.gpuEvidence).toString('base64'),
    },
    responseSignature: {
      signedText: signature.signedText,
      signature: signature.signature,
      algorithm: signature.algorithm,
      provenance: signature.provenance,
    },
  }), 'utf8');
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) {
    throw new Error('NEAR AI verification evidence exceeded its byte limit');
  }
  return bytes;
}

/**
 * Run one buffered direct-endpoint completion. No text is released before the
 * live TDX/GPU/TLS evidence and exact-byte Ed25519 response signature verify.
 */
export async function generate(
  apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions = {},
): Promise<VerifiedProviderOutput> {
  if (!apiKey) throw new Error('NEAR AI API key is required');
  if (model !== MODEL) throw new Error(`NEAR AI confidential mode requires ${MODEL}`);
  const inputMessages = toMessages(prompt);
  const hasInlineSystem = inputMessages.some((message) => message.role === 'system');
  const messages: ChatMessage[] = [];
  if (options.systemPrompt && !hasInlineSystem) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push(...inputMessages);
  const requestBytes = Buffer.from(JSON.stringify({
    model: MODEL,
    messages,
    stream: false,
    max_tokens: options.maxTokens ?? 1024,
    temperature: options.temperature ?? 0.3,
  }), 'utf8');
  if (requestBytes.byteLength > 1024 * 1024) throw new Error('NEAR AI request exceeded its byte limit');

  const client = new StrictConfidentialClient(
    new NearConfidentialTransport({ apiKey }),
    { stageTimeoutMs: options.timeoutMs ?? 120_000 },
  );
  const result = await client.generate(requestBytes, POLICY);
  if (!result.ok) {
    throw new Error(`NEAR AI confidential verification failed (${result.code}): ${result.message}`);
  }
  const parsed = JSON.parse(Buffer.from(result.bytes).toString('utf8')) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('NEAR AI returned no text completion');
  const verifiedAtMs = Date.parse(result.evidence.verifiedAt);
  if (!Number.isFinite(verifiedAtMs)) throw new Error('NEAR AI verification time is malformed');
  return Object.freeze({
    content,
    requestBytes: Uint8Array.from(requestBytes),
    responseBytes: Uint8Array.from(result.bytes),
    endpointIdentity: ENDPOINT,
    providerRequestId: result.chatId,
    resolvedModel: MODEL,
    verification: Object.freeze({
      outcome: 'verified' as const,
      inferenceId: result.chatId,
      attestationPolicyVersion: `nearai-direct:${APPROVED_COMPOSE_HASH}`,
      verifierVersion: NEAR_VERIFIER_VERSION,
      evidence: evidenceBundle(result.evidence, result.signature),
      measurementIdentity: result.evidence.attestation.measurement,
      responseSignature: responseSignature(result.signature),
      verifiedAt: result.evidence.verifiedAt,
      freshUntil: new Date(verifiedAtMs + POLICY.maxAgeMs).toISOString(),
    }),
  });
}
