import {
  sha256Hex,
  signInferenceReceipt,
  type InferenceReceiptExportV1,
} from '@skytwin/shared-types';
import type { InferenceTrace } from './types.js';

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

function receiptReasoningMode(trace: InferenceTrace) {
  const { execution, status } = trace;
  const { capabilities } = execution;
  const lastAttempt = execution.executionPath.at(-1);
  if (!lastAttempt || lastAttempt.provider !== execution.provider) {
    throw new Error('Receipt trace must end with the observed provider attempt');
  }
  if (execution.reasoningMode === 'on_device') {
    if (capabilities.executionLocation !== 'on_device' ||
        (capabilities.networkScope !== 'none' && capabilities.networkScope !== 'loopback') ||
        capabilities.confidentiality !== 'device_local' ||
        capabilities.pricing.kind !== 'zero' ||
        (status !== 'on_device' && status !== 'local_fallback') ||
        lastAttempt.outcome !== 'succeeded') {
      throw new Error('On-device receipt facts do not match the selected reasoning mode');
    }
    return 'on_device' as const;
  }
  if (execution.reasoningMode === 'bring_your_own_provider') {
    if (capabilities.executionLocation !== 'remote_service' ||
        capabilities.networkScope !== 'external' ||
        status !== 'conventional' ||
        lastAttempt.outcome !== 'succeeded') {
      throw new Error('Conventional receipt facts do not match the selected reasoning mode');
    }
    return 'conventional_cloud' as const;
  }
  if (capabilities.executionLocation !== 'remote_service' ||
      capabilities.networkScope !== 'external' ||
      capabilities.confidentiality !== 'attested_tee' ||
      capabilities.attestationPolicy !== 'required' ||
      !['verified', 'verification_failed', 'verification_unavailable', 'verification_stale']
        .includes(status) ||
      (status === 'verified' ? lastAttempt.outcome !== 'succeeded' : lastAttempt.outcome !== 'failed')) {
    throw new Error('Confidential receipt facts do not match the selected reasoning mode');
  }
  return 'verified_confidential' as const;
}

/**
 * Finalize one boundary trace only after its durable decision and explanation
 * identifiers exist. Raw bytes remain in transient request memory until their
 * references are released and garbage-collected; the repository never persists
 * them.
 */
export function emitInferenceReceipt(
  trace: InferenceTrace,
  linkage: ReceiptLinkage,
  signingKey: ReceiptSigningKey,
): InferenceReceiptExportV1 {
  const reasoningMode = receiptReasoningMode(trace);
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
    reasoningMode,
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
