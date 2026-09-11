import { createHash, sign, verify } from 'node:crypto';
import type {
  ProviderConfidentiality,
  ProviderExecutionAttempt,
  ProviderExecutionLocation,
  ProviderNetworkScope,
  ProviderVerificationStatus,
  ReasoningMode,
} from './reasoning-mode.js';

/** What actually executed, distinct from the user's routing policy. */
export type InferenceExecutionClass =
  | 'on_device'
  | 'verified_confidential'
  | 'conventional_cloud';

export type InferenceReceiptStatus =
  | 'on_device'
  | 'verified'
  | 'conventional'
  | 'verification_failed'
  | 'verification_unavailable'
  | 'verification_stale'
  | 'local_fallback';

export interface InferenceFallbackV1 {
  origin: 'verified_private_cloud';
  destination: 'on_device';
  reason: string;
}

export interface InferenceCostV1 {
  basis: 'exact' | 'unknown';
  currency?: string;
  amountMinor?: number;
  billingId?: string;
}

export interface ReceiptSignatureV1 {
  algorithm: 'Ed25519';
  keyId: string;
  publicKeyPem: string;
  signatureBase64: string;
}

/**
 * Metadata-only audit record. Request, response, credentials, chain-of-thought,
 * and full attestation evidence are deliberately excluded.
 */
export interface InferenceReceiptV1 {
  version: 1;
  id: string;
  userId: string;
  decisionId: string;
  explanationId: string;
  /** Persisted user-selected routing policy used for this invocation. */
  reasoningMode: ReasoningMode;
  /** Observed execution class, derived from typed provider capabilities. */
  executionClass: InferenceExecutionClass;
  executionLocation: ProviderExecutionLocation;
  networkScope: ProviderNetworkScope;
  confidentiality: ProviderConfidentiality;
  verificationStatus: ProviderVerificationStatus;
  executionPath: readonly ProviderExecutionAttempt[];
  provider: string;
  model: string;
  endpointIdentity: string;
  requestSha256: string;
  responseSha256: string;
  inferenceId?: string;
  attestationPolicyVersion?: string;
  verifierVersion: string;
  evidenceSha256?: string;
  measurementIdentity?: string;
  responseSignature?: ReceiptSignatureV1;
  verifiedAt?: string;
  freshUntil?: string;
  fallback?: InferenceFallbackV1;
  cost: InferenceCostV1;
  status: InferenceReceiptStatus;
  createdAt: string;
  seal: ReceiptSignatureV1;
}

export interface InferenceReceiptExportV1 {
  exportVersion: 1;
  receipt: InferenceReceiptV1;
  requestBase64: string;
  responseBase64: string;
  evidenceBase64?: string;
  disclosure: string;
}

export type ReceiptVerificationCode =
  | 'PASS'
  | 'INTEGRITY_ONLY'
  | 'UNTRUSTED_RECORDER'
  | 'UNTRUSTED_PROVIDER'
  | 'ATTESTATION_REJECTED'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_RECEIPT'
  | 'REQUEST_HASH_MISMATCH'
  | 'RESPONSE_HASH_MISMATCH'
  | 'EVIDENCE_REQUIRED'
  | 'EVIDENCE_HASH_MISMATCH'
  | 'RESPONSE_SIGNATURE_INVALID'
  | 'SEAL_SIGNATURE_INVALID'
  | 'STALE_VERIFICATION';

export interface ReceiptVerificationResult {
  valid: boolean;
  /** True only when configured trust roots and, where applicable, attestation policy passed. */
  trusted: boolean;
  code: ReceiptVerificationCode;
  receiptId?: string;
}

export interface AttestationVerificationInput {
  receipt: InferenceReceiptV1;
  evidence: Uint8Array;
  request: Uint8Array;
  response: Uint8Array;
}

export interface ReceiptVerificationOptions {
  now?: Date;
  /**
   * Verify hashes and embedded signatures without treating embedded identities
   * or attestation evidence as trusted. This can only return INTEGRITY_ONLY.
   */
  integrityOnly?: boolean;
  trustedRecorderKeys?: ReadonlyMap<string, string>;
  trustedProviderKeys?: ReadonlyMap<string, string>;
  verifyAttestation?: (input: AttestationVerificationInput) => boolean;
  maxVerificationAgeMs?: number;
  futureClockSkewMs?: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('lone Unicode surrogate');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('lone Unicode surrogate');
    }
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('receipt must contain only JSON values');
  }
  const record = value as Record<string, unknown>;
  if (Object.values(record).some((item) => item === undefined)) throw new TypeError('undefined JSON member');
  Object.keys(record).forEach(assertValidUnicode);
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function receiptSealPayload(receipt: Omit<InferenceReceiptV1, 'seal'>): Buffer {
  return Buffer.from(canonicalize(receipt), 'utf8');
}

export function signInferenceReceipt(
  receipt: Omit<InferenceReceiptV1, 'seal'>,
  key: { keyId: string; privateKeyPem: string; publicKeyPem: string },
): InferenceReceiptV1 {
  const signatureBase64 = sign(null, receiptSealPayload(receipt), key.privateKeyPem).toString('base64');
  return {
    ...receipt,
    seal: { algorithm: 'Ed25519', keyId: key.keyId, publicKeyPem: key.publicKeyPem, signatureBase64 },
  };
}

function fail(code: ReceiptVerificationCode, receiptId?: string): ReceiptVerificationResult {
  return { valid: false, trusted: false, code, receiptId };
}

const MODES = new Set<ReasoningMode>(['on_device', 'verified_private_cloud', 'bring_your_own_provider']);
const EXECUTION_CLASSES = new Set<InferenceExecutionClass>(['on_device', 'verified_confidential', 'conventional_cloud']);
const EXECUTION_LOCATIONS = new Set<ProviderExecutionLocation>(['on_device', 'remote_service']);
const NETWORK_SCOPES = new Set<ProviderNetworkScope>(['none', 'loopback', 'external']);
const CONFIDENTIALITIES = new Set<ProviderConfidentiality>([
  'device_local', 'provider_standard', 'operator_declared', 'attested_tee',
]);
const VERIFICATION_STATUSES = new Set<ProviderVerificationStatus>([
  'not_applicable', 'required_missing', 'verified', 'failed',
]);
const STATUSES = new Set<InferenceReceiptStatus>(['on_device', 'verified', 'conventional', 'verification_failed', 'verification_unavailable', 'verification_stale', 'local_fallback']);
function validCost(cost: unknown): cost is InferenceCostV1 {
  if (!cost || typeof cost !== 'object') return false;
  const c = cost as Record<string, unknown>;
  if (Object.keys(c).some((key) => !['basis', 'currency', 'amountMinor', 'billingId'].includes(key))) return false;
  if (c['basis'] !== 'exact' && c['basis'] !== 'unknown') return false;
  if (c['billingId'] !== undefined && (typeof c['billingId'] !== 'string' || c['billingId'].length === 0)) return false;
  if (c['basis'] === 'unknown') return c['currency'] === undefined && c['amountMinor'] === undefined;
  return typeof c['currency'] === 'string' && c['currency'].length > 0 &&
    Number.isSafeInteger(c['amountMinor']) && (c['amountMinor'] as number) >= 0;
}

function validSignature(value: unknown): value is ReceiptSignatureV1 {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return Object.keys(s).every((key) => ['algorithm', 'keyId', 'publicKeyPem', 'signatureBase64'].includes(key)) &&
    s['algorithm'] === 'Ed25519' && typeof s['keyId'] === 'string' && s['keyId'].length > 0 &&
    typeof s['publicKeyPem'] === 'string' && s['publicKeyPem'].length > 0 &&
    typeof s['signatureBase64'] === 'string' && decodeBase64(s['signatureBase64']) !== null;
}

function validShape(receipt: InferenceReceiptV1): boolean {
  const allowed = new Set(['version', 'id', 'userId', 'decisionId', 'explanationId', 'reasoningMode',
    'executionClass', 'executionLocation', 'networkScope', 'confidentiality', 'verificationStatus',
    'executionPath',
    'provider', 'model', 'endpointIdentity', 'requestSha256', 'responseSha256', 'inferenceId',
    'attestationPolicyVersion', 'verifierVersion', 'evidenceSha256', 'measurementIdentity',
    'responseSignature', 'verifiedAt', 'freshUntil', 'fallback', 'cost', 'status', 'createdAt', 'seal']);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) return false;
  const strings = [receipt.id, receipt.userId, receipt.decisionId, receipt.explanationId, receipt.provider,
    receipt.model, receipt.endpointIdentity, receipt.verifierVersion, receipt.createdAt];
  const optionalStrings = [receipt.inferenceId, receipt.attestationPolicyVersion, receipt.evidenceSha256,
    receipt.measurementIdentity, receipt.verifiedAt, receipt.freshUntil];
  return strings.every((v) => typeof v === 'string' && v.length > 0) &&
    optionalStrings.every((v) => v === undefined || (typeof v === 'string' && v.length > 0)) &&
    MODES.has(receipt.reasoningMode) && EXECUTION_CLASSES.has(receipt.executionClass) &&
    EXECUTION_LOCATIONS.has(receipt.executionLocation) && NETWORK_SCOPES.has(receipt.networkScope) &&
    CONFIDENTIALITIES.has(receipt.confidentiality) &&
    VERIFICATION_STATUSES.has(receipt.verificationStatus) &&
    validExecutionPath(receipt.executionPath, receipt.provider) &&
    STATUSES.has(receipt.status) && validCost(receipt.cost) &&
    validSignature(receipt.seal) && (receipt.responseSignature === undefined || validSignature(receipt.responseSignature)) &&
    (receipt.fallback === undefined || (Object.keys(receipt.fallback).every((key) => ['origin', 'destination', 'reason'].includes(key)) &&
      receipt.fallback.origin === 'verified_private_cloud' && receipt.fallback.destination === 'on_device' &&
      typeof receipt.fallback.reason === 'string' && receipt.fallback.reason.length > 0)) &&
    Number.isFinite(new Date(receipt.createdAt).getTime());
}

function validExecutionPath(value: unknown, finalProvider: string): value is readonly ProviderExecutionAttempt[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  let successes = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') return false;
    const attempt = item as Record<string, unknown>;
    if (!Object.keys(attempt).every((key) => [
      'provider', 'executionLocation', 'networkScope', 'confidentiality', 'outcome',
    ].includes(key))) return false;
    if (typeof attempt['provider'] !== 'string' || attempt['provider'].length === 0 ||
        !EXECUTION_LOCATIONS.has(attempt['executionLocation'] as ProviderExecutionLocation) ||
        !NETWORK_SCOPES.has(attempt['networkScope'] as ProviderNetworkScope) ||
        !CONFIDENTIALITIES.has(attempt['confidentiality'] as ProviderConfidentiality) ||
        !['succeeded', 'failed', 'circuit_open', 'price_unavailable'].includes(String(attempt['outcome']))) {
      return false;
    }
    if (attempt['outcome'] === 'succeeded') {
      successes += 1;
      if (attempt['provider'] !== finalProvider || item !== value[value.length - 1]) return false;
    }
  }
  return successes === 1;
}

const VERIFIED_ONLY_FIELDS = [
  'attestationPolicyVersion', 'evidenceSha256', 'measurementIdentity', 'responseSignature',
  'verifiedAt', 'freshUntil',
] as const;

function validStatusShape(receipt: InferenceReceiptV1, evidenceBase64: unknown): boolean {
  if (receipt.status === 'verified') {
    return receipt.reasoningMode === 'verified_private_cloud' &&
      receipt.executionClass === 'verified_confidential' &&
      receipt.executionLocation === 'remote_service' && receipt.networkScope === 'external' &&
      receipt.confidentiality === 'attested_tee' && receipt.verificationStatus === 'verified' &&
      receipt.executionPath.every((attempt) => attempt.executionLocation === 'remote_service' &&
        attempt.networkScope === 'external' && attempt.confidentiality === 'attested_tee') &&
      receipt.fallback === undefined &&
      VERIFIED_ONLY_FIELDS.every((field) => receipt[field] !== undefined) &&
      typeof evidenceBase64 === 'string' && evidenceBase64.length > 0;
  }
  if (VERIFIED_ONLY_FIELDS.some((field) => receipt[field] !== undefined) || evidenceBase64 !== undefined) return false;
  if (receipt.status === 'local_fallback') {
    return receipt.reasoningMode === 'verified_private_cloud' &&
      receipt.executionClass === 'on_device' && receipt.executionLocation === 'on_device' &&
      receipt.networkScope !== 'external' && receipt.confidentiality === 'device_local' &&
      receipt.verificationStatus === 'not_applicable' && receipt.fallback !== undefined;
  }
  if (receipt.fallback !== undefined) return false;
  if (receipt.status === 'on_device') {
    return receipt.reasoningMode === 'on_device' && receipt.executionClass === 'on_device' &&
      receipt.executionLocation === 'on_device' &&
      receipt.networkScope !== 'external' && receipt.confidentiality === 'device_local' &&
      receipt.verificationStatus === 'not_applicable' &&
      receipt.executionPath.every((attempt) => attempt.executionLocation === 'on_device' &&
        attempt.networkScope !== 'external' && attempt.confidentiality === 'device_local');
  }
  if (receipt.status === 'conventional') {
    return receipt.reasoningMode === 'bring_your_own_provider' &&
      receipt.executionClass === 'conventional_cloud' && receipt.executionLocation === 'remote_service' &&
      receipt.networkScope === 'external' &&
      (receipt.confidentiality === 'provider_standard' || receipt.confidentiality === 'operator_declared') &&
      receipt.verificationStatus === 'not_applicable' &&
      receipt.executionPath.every((attempt) => attempt.executionLocation === 'remote_service' &&
        attempt.networkScope === 'external' &&
        (attempt.confidentiality === 'provider_standard' ||
          attempt.confidentiality === 'operator_declared'));
  }
  return receipt.reasoningMode === 'verified_private_cloud' &&
    receipt.executionClass === 'verified_confidential' && receipt.executionLocation === 'remote_service' &&
    receipt.networkScope === 'external' && receipt.confidentiality === 'attested_tee' &&
    receipt.executionPath.every((attempt) => attempt.executionLocation === 'remote_service' &&
      attempt.networkScope === 'external' && attempt.confidentiality === 'attested_tee') &&
    (receipt.verificationStatus === 'failed' || receipt.verificationStatus === 'required_missing');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  return Buffer.from(value, 'base64');
}

function verifyExport(
  bundle: InferenceReceiptExportV1,
  options: ReceiptVerificationOptions = {},
): ReceiptVerificationResult {
  if (!bundle || typeof bundle !== 'object' || !bundle.receipt || typeof bundle.receipt !== 'object') {
    return fail('INVALID_RECEIPT');
  }
  const bundleRecord = bundle as unknown as Record<string, unknown>;
  const allowedBundleFields = new Set([
    'exportVersion', 'receipt', 'requestBase64', 'responseBase64', 'evidenceBase64', 'disclosure',
  ]);
  if (Object.keys(bundleRecord).some((key) => !allowedBundleFields.has(key)) ||
      typeof bundle.disclosure !== 'string' || bundle.disclosure.length === 0) {
    return fail('INVALID_RECEIPT');
  }
  if (bundle.exportVersion !== 1 || bundle.receipt.version !== 1) return fail('UNSUPPORTED_VERSION');
  const receipt = bundle.receipt;
  if (!validShape(receipt)) return fail('INVALID_RECEIPT', receipt.id);
  if (!receipt.seal || receipt.seal.algorithm !== 'Ed25519' ||
      typeof receipt.seal.keyId !== 'string' || typeof receipt.seal.publicKeyPem !== 'string' ||
      typeof receipt.seal.signatureBase64 !== 'string' || !isSha256(receipt.requestSha256) ||
      !isSha256(receipt.responseSha256)) return fail('INVALID_RECEIPT', receipt.id);
  const request = decodeBase64(bundle.requestBase64);
  const response = decodeBase64(bundle.responseBase64);
  if (!request || !response) return fail('INVALID_RECEIPT', receipt.id);
  if (sha256(request) !== receipt.requestSha256) return fail('REQUEST_HASH_MISMATCH', receipt.id);
  if (sha256(response) !== receipt.responseSha256) return fail('RESPONSE_HASH_MISMATCH', receipt.id);

  const { seal, ...unsigned } = receipt;
  if (!verify(null, receiptSealPayload(unsigned), seal.publicKeyPem,
    Buffer.from(seal.signatureBase64, 'base64'))) {
    return fail('SEAL_SIGNATURE_INVALID', receipt.id);
  }

  const expectedClass: Record<InferenceReceiptStatus, InferenceExecutionClass> = {
    on_device: 'on_device', conventional: 'conventional_cloud', verified: 'verified_confidential',
    verification_failed: 'verified_confidential', verification_unavailable: 'verified_confidential',
    verification_stale: 'verified_confidential', local_fallback: 'on_device',
  };
  if (expectedClass[receipt.status] !== receipt.executionClass) return fail('INVALID_RECEIPT', receipt.id);
  if (!validStatusShape(receipt, bundle.evidenceBase64)) return fail('INVALID_RECEIPT', receipt.id);
  if (receipt.status === 'verified') {
    if (!bundle.evidenceBase64 || !receipt.evidenceSha256 || !receipt.attestationPolicyVersion ||
        !receipt.measurementIdentity || !receipt.responseSignature || !receipt.verifiedAt || !receipt.freshUntil) {
      return fail('EVIDENCE_REQUIRED', receipt.id);
    }
    const evidence = decodeBase64(bundle.evidenceBase64);
    if (!evidence || !isSha256(receipt.evidenceSha256)) return fail('EVIDENCE_REQUIRED', receipt.id);
    if (sha256(evidence) !== receipt.evidenceSha256) return fail('EVIDENCE_HASH_MISMATCH', receipt.id);
    if (receipt.responseSignature.algorithm !== 'Ed25519') return fail('RESPONSE_SIGNATURE_INVALID', receipt.id);
    if (!verify(null, response, receipt.responseSignature.publicKeyPem,
      Buffer.from(receipt.responseSignature.signatureBase64, 'base64'))) {
      return fail('RESPONSE_SIGNATURE_INVALID', receipt.id);
    }
    const verifiedAt = new Date(receipt.verifiedAt).getTime();
    const freshUntil = new Date(receipt.freshUntil).getTime();
    if (!Number.isFinite(verifiedAt) || !Number.isFinite(freshUntil) || verifiedAt > freshUntil) {
      return fail('INVALID_RECEIPT', receipt.id);
    }
    const now = (options.now ?? new Date()).getTime();
    if (verifiedAt > now + (options.futureClockSkewMs ?? 60_000)) return fail('INVALID_RECEIPT', receipt.id);
    if (freshUntil - verifiedAt > (options.maxVerificationAgeMs ?? 7 * 24 * 60 * 60 * 1000)) return fail('INVALID_RECEIPT', receipt.id);
    if (freshUntil < now) {
      return fail('STALE_VERIFICATION', receipt.id);
    }
    if (options.integrityOnly === true) {
      return { valid: true, trusted: false, code: 'INTEGRITY_ONLY', receiptId: receipt.id };
    }
    const providerKey = options.trustedProviderKeys?.get(receipt.responseSignature.keyId);
    if (!providerKey || providerKey !== receipt.responseSignature.publicKeyPem) return fail('UNTRUSTED_PROVIDER', receipt.id);
    if (!options.verifyAttestation?.({ receipt, evidence, request, response })) return fail('ATTESTATION_REJECTED', receipt.id);
  }
  if (options.integrityOnly === true) {
    return { valid: true, trusted: false, code: 'INTEGRITY_ONLY', receiptId: receipt.id };
  }
  const recorderKey = options.trustedRecorderKeys?.get(seal.keyId);
  if (!recorderKey || recorderKey !== seal.publicKeyPem) {
    return { valid: true, trusted: false, code: 'INTEGRITY_ONLY', receiptId: receipt.id };
  }
  return { valid: true, trusted: true, code: 'PASS', receiptId: receipt.id };
}

export function verifyInferenceReceiptExport(
  bundle: InferenceReceiptExportV1,
  options: ReceiptVerificationOptions | Date = {},
): ReceiptVerificationResult {
  try {
    return verifyExport(bundle, options instanceof Date ? { now: options } : options);
  } catch {
    return fail('INVALID_RECEIPT');
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return sha256(bytes);
}
