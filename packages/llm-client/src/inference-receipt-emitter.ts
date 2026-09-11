import {
  sha256Hex,
  signInferenceReceipt,
  type InferenceReceiptExportV1,
} from '@skytwin/shared-types';
import type { InferenceTrace } from './types.js';
import { executionClassForMetadata } from './provider-privacy.js';

export interface ReceiptLinkage {
  userId: string;
  decisionId: string;
  explanationId: string;
}

export interface ReceiptSigningKey {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * Finalize one boundary trace only after its durable decision and explanation
 * identifiers exist. The raw bytes are used for verification, then discarded
 * by the metadata-only repository.
 */
export function emitInferenceReceipt(
  trace: InferenceTrace,
  linkage: ReceiptLinkage,
  signingKey: ReceiptSigningKey,
): InferenceReceiptExportV1 {
  const verified = trace.status === 'verified' ? trace.verification : undefined;
  if (trace.status === 'verified' && !verified) {
    throw new Error('Verified receipt emission requires a trusted verifier result');
  }
  if (trace.status !== 'verified' && trace.verification) {
    throw new Error('Attestation fields are forbidden on non-verified receipts');
  }

  const receipt = signInferenceReceipt({
    version: 1,
    id: trace.id,
    ...linkage,
    reasoningMode: trace.execution.reasoningMode,
    executionClass: executionClassForMetadata(trace.execution),
    executionLocation: trace.execution.capabilities.executionLocation,
    networkScope: trace.execution.capabilities.networkScope,
    confidentiality: trace.execution.capabilities.confidentiality,
    verificationStatus: trace.execution.verificationStatus,
    executionPath: trace.execution.executionPath,
    provider: trace.execution.provider,
    model: trace.execution.model,
    endpointIdentity: trace.endpointIdentity,
    requestSha256: sha256Hex(trace.request),
    responseSha256: sha256Hex(trace.response),
    verifierVersion: trace.verifierVersion,
    cost: trace.cost,
    status: trace.status,
    createdAt: trace.createdAt,
    ...(trace.fallback ? { fallback: trace.fallback } : {}),
    ...(verified ? {
      ...(verified.inferenceId ? { inferenceId: verified.inferenceId } : {}),
      attestationPolicyVersion: verified.attestationPolicyVersion,
      evidenceSha256: sha256Hex(verified.evidence),
      measurementIdentity: verified.measurementIdentity,
      responseSignature: verified.responseSignature,
      verifiedAt: verified.verifiedAt,
      freshUntil: verified.freshUntil,
    } : {}),
  }, signingKey);

  return {
    exportVersion: 1,
    receipt,
    requestBase64: Buffer.from(trace.request).toString('base64'),
    responseBase64: Buffer.from(trace.response).toString('base64'),
    ...(verified ? { evidenceBase64: Buffer.from(verified.evidence).toString('base64') } : {}),
    disclosure: 'Contains SkyTwin canonical logical inference input/output bytes for independent verification; these are not provider HTTP wire bytes. Protect or delete this export after use.',
  };
}
