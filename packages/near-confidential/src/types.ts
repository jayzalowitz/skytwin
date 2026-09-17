export type ConfidentialFailureCode =
  | "invalid_policy"
  | "verifier_unavailable"
  | "catalog_unavailable"
  | "catalog_ambiguous"
  | "model_ineligible"
  | "endpoint_ineligible"
  | "attestation_invalid"
  | "attestation_stale"
  | "attestation_policy_mismatch"
  | "tls_binding_invalid"
  | "transport_failed"
  | "signature_unavailable"
  | "response_signature_invalid"
  | "response_signer_mismatch"
  | "response_provenance_mismatch"
  | "resource_limit_exceeded";

export interface ConfidentialFailure {
  ok: false;
  code: ConfidentialFailureCode;
  message: string;
  promptTransmitted: boolean;
}
export interface ConfidentialModel {
  id: string;
  directEndpoint: string;
  verifiable: boolean;
  attestationSupported: boolean;
  vllmCompatible: boolean;
}
export type SignatureAlgorithm = "ecdsa-secp256k1" | "ed25519";
export type SignatureProvenance = "provider_tee" | "gateway";
export type SignatureScheme = "eip191-personal-sign" | "ed25519-raw";
export type SignedTextFormat = "model:request_sha256:response_sha256";

export interface AttestationPolicy {
  modelId: string;
  directEndpoint: string;
  approvedMeasurements: readonly string[];
  maxAgeMs: number;
  verifierVersion: string;
  signatureAlgorithm: SignatureAlgorithm;
  /** Direct endpoints must require provider_tee. Gateway is modeled for future use only. */
  signatureProvenance: SignatureProvenance;
}

export interface ReportDataBinding {
  scheme: "sha256(signing_identity||tls_spki_sha256)||nonce";
  signingIdentity: string;
  tlsSpkiSha256: string;
  nonceHex: string;
}

export interface AttestationProofSummary {
  /** Opaque verified Intel TDX quote bytes, retained for future audit receipts. */
  tdxQuote: Uint8Array;
  tdxVerified: true;
  /** Includes NVIDIA evidence validation and its client-nonce match. */
  gpuEvidence: Uint8Array;
  gpuVerified: true;
  /** Compose/model measurement obtained from the verified quote. */
  measurement: string;
  /** model_name returned from inside the measured inference proxy. */
  modelName: string;
  reportData: ReportDataBinding;
}

export interface VerifiedChannelEvidence {
  modelId: string;
  directEndpoint: string;
  verifiedAt: string;
  verifierVersion: string;
  signingIdentity: string;
  signatureAlgorithm: SignatureAlgorithm;
  /** Authenticated from the verified channel/route; never inferred from response JSON. */
  signatureProvenance: SignatureProvenance;
  tlsSpkiSha256: string;
  attestation: AttestationProofSummary;
  /** True only when attestation and prompt bytes use this channel's one live TLS connection. */
  sameConnection: true;
}

export interface ExactResponse {
  bytes: Uint8Array;
  chatId: string;
  modelId: string;
}

/**
 * Verifier-normalized signature record. The raw NEAR endpoint currently returns
 * only text, signature, signing_address, and signing_algo. A transport must bind
 * the remaining identity and provenance fields to its authenticated channel;
 * it must never infer provenance from caller input or stamp a trusted default.
 */
export interface NormalizedResponseSignatureRecord {
  chatId: string;
  modelId: string;
  signedText: string;
  signature: string;
  signingIdentity: string;
  algorithm: SignatureAlgorithm;
  scheme: SignatureScheme;
  signedTextFormat: SignedTextFormat;
  provenance: SignatureProvenance;
}

export interface VerifiedConfidentialResponse {
  ok: true;
  bytes: Uint8Array;
  chatId: string;
  evidence: VerifiedChannelEvidence;
}
export type ConfidentialResult =
  VerifiedConfidentialResponse | ConfidentialFailure;

export interface ConfidentialResourceLimits {
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxCatalogModels: number;
  maxApprovedMeasurements: number;
  maxAttestationProofBytes: number;
  maxStringChars: number;
  maxSignatureChars: number;
}

/**
 * Every transport stage receives the same immutable limits and a stage-local
 * abort signal. Implementations must honor cancellation or eventually settle:
 * after a timeout the client waits for settlement before closing the channel,
 * so close never races an in-flight channel operation.
 */
export interface ConfidentialOperationContext {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly limits: Readonly<ConfidentialResourceLimits>;
}

/** Opaque connection state remains behind this channel-scoped capability. */
export interface VerifiedChannel {
  readonly evidence: VerifiedChannelEvidence;
  send(
    requestBytes: Uint8Array,
    context: ConfidentialOperationContext,
  ): Promise<ExactResponse>;
  retrieveSignature(
    input: { chatId: string; modelId: string; algorithm: SignatureAlgorithm },
    context: ConfidentialOperationContext,
  ): Promise<NormalizedResponseSignatureRecord>;
  verifyExactResponse(
    input: {
      requestBytes: Uint8Array;
      responseBytes: Uint8Array;
      response: ExactResponse;
      signature: NormalizedResponseSignatureRecord;
      /** Verifies signature over signedText, including its domain/tag when present. */
    },
    context: ConfidentialOperationContext,
  ): Promise<boolean>;
  close(context: ConfidentialOperationContext): Promise<void>;
}

/**
 * Security boundary implemented by a pinned, independently reviewed verifier.
 * It validates the TDX quote, GPU evidence/nonce and report_data signer/TLS-SPKI
 * binding before returning a channel that reuses that exact TLS connection.
 */
export interface ConfidentialTransport {
  discoverModels(
    context: ConfidentialOperationContext,
  ): Promise<readonly ConfidentialModel[]>;
  openVerifiedChannel(
    input: { policy: AttestationPolicy; nonce: Uint8Array },
    context: ConfidentialOperationContext,
  ): Promise<VerifiedChannel | ConfidentialFailure>;
}
