import type {
  ProviderExecutionMetadata,
  ProviderPricingCapability,
} from '@skytwin/shared-types';
import type {
  InferenceTrace,
  TrustedConfidentialVerification,
} from './types.js';

function snapshotPricing(
  pricing: ProviderPricingCapability,
): ProviderPricingCapability {
  return Object.freeze({ ...pricing });
}

/** Deep, credential-free snapshot safe to expose on a normalized response. */
export function snapshotProviderExecutionMetadata(
  execution: ProviderExecutionMetadata,
): ProviderExecutionMetadata {
  return Object.freeze({
    reasoningMode: execution.reasoningMode,
    provider: execution.provider,
    model: execution.model,
    request: Object.freeze({ ...execution.request }),
    capabilities: Object.freeze({
      executionLocation: execution.capabilities.executionLocation,
      networkScope: execution.capabilities.networkScope,
      confidentiality: execution.capabilities.confidentiality,
      attestationPolicy: execution.capabilities.attestationPolicy,
      retention: Object.freeze({ ...execution.capabilities.retention }),
      modalities: Object.freeze([...execution.capabilities.modalities]),
      pricing: snapshotPricing(execution.capabilities.pricing),
    }),
    verificationStatus: execution.verificationStatus,
    executionPath: Object.freeze(execution.executionPath.map((attempt) =>
      Object.freeze({ ...attempt }))),
    costBasis: Object.freeze({
      pricing: snapshotPricing(execution.costBasis.pricing),
      inputTokens: execution.costBasis.inputTokens,
      outputTokens: execution.costBasis.outputTokens,
    }),
    receiptId: execution.receiptId,
  });
}

function snapshotVerification(
  verification: TrustedConfidentialVerification,
): TrustedConfidentialVerification {
  return Object.freeze({
    outcome: 'verified',
    ...(verification.inferenceId === undefined
      ? {}
      : { inferenceId: verification.inferenceId }),
    attestationPolicyVersion: verification.attestationPolicyVersion,
    verifierVersion: verification.verifierVersion,
    evidence: Uint8Array.from(verification.evidence),
    measurementIdentity: verification.measurementIdentity,
    responseSignature: Object.freeze({ ...verification.responseSignature }),
    verifiedAt: verification.verifiedAt,
    freshUntil: verification.freshUntil,
  });
}

/**
 * Snapshot the complete receipt input. Byte arrays are copied because freezing
 * an ArrayBuffer view does not make its elements immutable. Callers that retain
 * a trace must take this snapshot at their ownership boundary.
 */
export function snapshotInferenceTrace(trace: InferenceTrace): InferenceTrace {
  return Object.freeze({
    id: trace.id,
    status: trace.status,
    execution: snapshotProviderExecutionMetadata(trace.execution),
    endpointIdentity: trace.endpointIdentity,
    request: Uint8Array.from(trace.request),
    response: Uint8Array.from(trace.response),
    cost: Object.freeze({ ...trace.cost }),
    createdAt: trace.createdAt,
    verifierVersion: trace.verifierVersion,
    ...(trace.fallback === undefined
      ? {}
      : { fallback: Object.freeze({ ...trace.fallback }) }),
    ...(trace.verification === undefined
      ? {}
      : { verification: snapshotVerification(trace.verification) }),
    ...(trace.verificationFailureReason === undefined
      ? {}
      : { verificationFailureReason: trace.verificationFailureReason }),
  });
}
