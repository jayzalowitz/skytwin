import { createHash, sign, verify } from 'node:crypto';
import { types as utilTypes } from 'node:util';

export type InferenceReasoningMode =
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
  origin: 'verified_confidential';
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
  reasoningMode: InferenceReasoningMode;
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

const MODES = new Set<InferenceReasoningMode>(['on_device', 'verified_confidential', 'conventional_cloud']);
const STATUSES = new Set<InferenceReceiptStatus>(['on_device', 'verified', 'conventional', 'verification_failed', 'verification_unavailable', 'verification_stale', 'local_fallback']);
const RECEIPT_REQUIRED_FIELDS = ['version', 'id', 'userId', 'decisionId', 'explanationId', 'reasoningMode',
  'provider', 'model', 'endpointIdentity', 'requestSha256', 'responseSha256', 'verifierVersion', 'cost',
  'status', 'createdAt', 'seal'] as const;
const RECEIPT_OPTIONAL_FIELDS = ['inferenceId', 'attestationPolicyVersion', 'evidenceSha256',
  'measurementIdentity', 'responseSignature', 'verifiedAt', 'freshUntil', 'fallback'] as const;

/** Materialize own data properties once so accessors and proxies cannot change a verified value. */
function exactOwnRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return null;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
  if (required.some((key) => !keys.includes(key))) return null;
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        descriptor.value === undefined) return null;
    record[key] = descriptor.value;
  }
  return record;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function snapshotSignature(value: unknown): ReceiptSignatureV1 | null {
  const record = exactOwnRecord(value, ['algorithm', 'keyId', 'publicKeyPem', 'signatureBase64']);
  if (!record || record['algorithm'] !== 'Ed25519' || !nonEmptyString(record['keyId']) ||
      !nonEmptyString(record['publicKeyPem']) || !nonEmptyString(record['signatureBase64']) ||
      decodeBase64(record['signatureBase64']) === null) return null;
  return Object.freeze({ algorithm: 'Ed25519', keyId: record['keyId'], publicKeyPem: record['publicKeyPem'],
    signatureBase64: record['signatureBase64'] });
}

function snapshotCost(value: unknown): InferenceCostV1 | null {
  const record = exactOwnRecord(value, ['basis'], ['currency', 'amountMinor', 'billingId']);
  if (!record) return null;
  const billingId = record['billingId'];
  if (billingId !== undefined && !nonEmptyString(billingId)) return null;
  if (record['basis'] === 'unknown') {
    if (record['currency'] !== undefined || record['amountMinor'] !== undefined) return null;
    return Object.freeze({ basis: 'unknown', ...(billingId === undefined ? {} : { billingId }) });
  }
  if (record['basis'] !== 'exact' || !nonEmptyString(record['currency']) ||
      !Number.isSafeInteger(record['amountMinor']) || (record['amountMinor'] as number) < 0) return null;
  return Object.freeze({ basis: 'exact', currency: record['currency'], amountMinor: record['amountMinor'] as number,
    ...(billingId === undefined ? {} : { billingId }) });
}

function snapshotFallback(value: unknown): InferenceFallbackV1 | null {
  const record = exactOwnRecord(value, ['origin', 'destination', 'reason']);
  if (!record || record['origin'] !== 'verified_confidential' || record['destination'] !== 'on_device' ||
      !nonEmptyString(record['reason'])) return null;
  return Object.freeze({ origin: 'verified_confidential', destination: 'on_device', reason: record['reason'] });
}

/** Strict, exact-own, immutable receipt snapshot for persistence and display boundaries. */
export function snapshotInferenceReceipt(value: unknown): InferenceReceiptV1 | null {
  try {
    const record = exactOwnRecord(value, RECEIPT_REQUIRED_FIELDS, RECEIPT_OPTIONAL_FIELDS);
    if (!record) return null;
    const requiredStrings = ['id', 'userId', 'decisionId', 'explanationId', 'provider', 'model',
      'endpointIdentity', 'requestSha256', 'responseSha256', 'verifierVersion', 'createdAt'] as const;
    if (record['version'] !== 1 || requiredStrings.some((field) => !nonEmptyString(record[field])) ||
        !MODES.has(record['reasoningMode'] as InferenceReasoningMode) ||
        !STATUSES.has(record['status'] as InferenceReceiptStatus) ||
        !Number.isFinite(new Date(record['createdAt'] as string).getTime())) return null;
    const optionalStrings = ['inferenceId', 'attestationPolicyVersion', 'evidenceSha256',
      'measurementIdentity', 'verifiedAt', 'freshUntil'] as const;
    if (optionalStrings.some((field) => record[field] !== undefined && !nonEmptyString(record[field]))) return null;
    const cost = snapshotCost(record['cost']);
    const seal = snapshotSignature(record['seal']);
    const responseSignature = record['responseSignature'] === undefined ? undefined : snapshotSignature(record['responseSignature']);
    const fallback = record['fallback'] === undefined ? undefined : snapshotFallback(record['fallback']);
    if (!cost || !seal || responseSignature === null || fallback === null) return null;
    const snapshot: InferenceReceiptV1 = Object.freeze({
      version: 1, id: record['id'] as string, userId: record['userId'] as string,
      decisionId: record['decisionId'] as string, explanationId: record['explanationId'] as string,
      reasoningMode: record['reasoningMode'] as InferenceReasoningMode, provider: record['provider'] as string,
      model: record['model'] as string, endpointIdentity: record['endpointIdentity'] as string,
      requestSha256: record['requestSha256'] as string, responseSha256: record['responseSha256'] as string,
      ...(record['inferenceId'] === undefined ? {} : { inferenceId: record['inferenceId'] as string }),
      ...(record['attestationPolicyVersion'] === undefined ? {} : { attestationPolicyVersion: record['attestationPolicyVersion'] as string }),
      verifierVersion: record['verifierVersion'] as string,
      ...(record['evidenceSha256'] === undefined ? {} : { evidenceSha256: record['evidenceSha256'] as string }),
      ...(record['measurementIdentity'] === undefined ? {} : { measurementIdentity: record['measurementIdentity'] as string }),
      ...(responseSignature === undefined ? {} : { responseSignature }),
      ...(record['verifiedAt'] === undefined ? {} : { verifiedAt: record['verifiedAt'] as string }),
      ...(record['freshUntil'] === undefined ? {} : { freshUntil: record['freshUntil'] as string }),
      ...(fallback === undefined ? {} : { fallback }), cost,
      status: record['status'] as InferenceReceiptStatus, createdAt: record['createdAt'] as string, seal,
    });
    return isSha256(snapshot.requestSha256) && isSha256(snapshot.responseSha256) &&
      validReceiptStatusFields(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

/** Verify metadata integrity only; the embedded key identity remains untrusted. */
export function verifyInferenceReceiptSeal(value: unknown): boolean {
  const receipt = snapshotInferenceReceipt(value);
  if (!receipt) return false;
  const { seal, ...unsigned } = receipt;
  try {
    return verify(null, receiptSealPayload(unsigned), seal.publicKeyPem, Buffer.from(seal.signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/** Strictly snapshot an export before any trust callback or persistence call. */
export function snapshotInferenceReceiptExport(value: unknown): InferenceReceiptExportV1 | null {
  try {
    const record = exactOwnRecord(value, ['exportVersion', 'receipt', 'requestBase64', 'responseBase64', 'disclosure'],
      ['evidenceBase64']);
    if (!record) return null;
    const receipt = snapshotInferenceReceipt(record['receipt']);
    if (record['exportVersion'] !== 1 || !receipt || typeof record['requestBase64'] !== 'string' ||
        typeof record['responseBase64'] !== 'string' || !nonEmptyString(record['disclosure']) ||
        (record['evidenceBase64'] !== undefined && typeof record['evidenceBase64'] !== 'string')) return null;
    return Object.freeze({ exportVersion: 1, receipt, requestBase64: record['requestBase64'],
      responseBase64: record['responseBase64'],
      ...(record['evidenceBase64'] === undefined ? {} : { evidenceBase64: record['evidenceBase64'] as string }),
      disclosure: record['disclosure'] });
  } catch {
    return null;
  }
}

function hasUnsupportedReceiptVersion(value: unknown): boolean {
  const bundle = exactOwnRecord(value, ['exportVersion', 'receipt', 'requestBase64', 'responseBase64', 'disclosure'],
    ['evidenceBase64']);
  if (!bundle) return false;
  const receipt = exactOwnRecord(bundle['receipt'], RECEIPT_REQUIRED_FIELDS, RECEIPT_OPTIONAL_FIELDS);
  return bundle['exportVersion'] !== 1 || (receipt !== null && receipt['version'] !== 1);
}

const VERIFIED_ONLY_FIELDS = [
  'attestationPolicyVersion', 'evidenceSha256', 'measurementIdentity', 'responseSignature',
  'verifiedAt', 'freshUntil',
] as const;

function validReceiptStatusFields(receipt: InferenceReceiptV1): boolean {
  const expectedMode: Record<InferenceReceiptStatus, InferenceReasoningMode> = {
    on_device: 'on_device', conventional: 'conventional_cloud', verified: 'verified_confidential',
    verification_failed: 'verified_confidential', verification_unavailable: 'verified_confidential',
    verification_stale: 'verified_confidential', local_fallback: 'on_device',
  };
  if (expectedMode[receipt.status] !== receipt.reasoningMode) return false;
  if (receipt.status === 'verified') {
    return receipt.reasoningMode === 'verified_confidential' && receipt.fallback === undefined &&
      VERIFIED_ONLY_FIELDS.every((field) => receipt[field] !== undefined);
  }
  if (VERIFIED_ONLY_FIELDS.some((field) => receipt[field] !== undefined)) return false;
  if (receipt.status === 'local_fallback') {
    return receipt.reasoningMode === 'on_device' && receipt.fallback !== undefined;
  }
  return receipt.fallback === undefined;
}

function validStatusShape(receipt: InferenceReceiptV1, evidenceBase64: unknown): boolean {
  return validReceiptStatusFields(receipt) && (receipt.status === 'verified'
    ? typeof evidenceBase64 === 'string' && evidenceBase64.length > 0
    : evidenceBase64 === undefined);
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
  input: unknown,
  options: ReceiptVerificationOptions = {},
): ReceiptVerificationResult {
  const bundle = snapshotInferenceReceiptExport(input);
  if (!bundle) return fail(hasUnsupportedReceiptVersion(input) ? 'UNSUPPORTED_VERSION' : 'INVALID_RECEIPT');
  const receipt = bundle.receipt;
  if (!isSha256(receipt.requestSha256) ||
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
    if (freshUntil <= now) {
      return fail('STALE_VERIFICATION', receipt.id);
    }
    if (options.integrityOnly === true) {
      return { valid: true, trusted: false, code: 'INTEGRITY_ONLY', receiptId: receipt.id };
    }
    const providerKey = options.trustedProviderKeys?.get(receipt.responseSignature.keyId);
    if (!providerKey || providerKey !== receipt.responseSignature.publicKeyPem) return fail('UNTRUSTED_PROVIDER', receipt.id);
    if (!options.verifyAttestation?.({ receipt, evidence: Buffer.from(evidence),
      request: Buffer.from(request), response: Buffer.from(response) })) return fail('ATTESTATION_REJECTED', receipt.id);
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
  bundle: unknown,
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
