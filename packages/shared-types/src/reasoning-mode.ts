/** Where a provider executes relative to the SkyTwin installation. */
export type ProviderExecutionLocation = 'on_device' | 'remote_service';

/** The network boundary crossed by an inference request. */
export type ProviderNetworkScope = 'none' | 'loopback' | 'external';

/**
 * Confidentiality is an explicit capability, never inferred from a provider
 * label, HTTPS, or an OpenAI-compatible base URL.
 */
export type ProviderConfidentiality =
  | 'device_local'
  | 'provider_standard'
  | 'operator_declared'
  | 'attested_tee';

export type ProviderAttestationPolicy = 'not_applicable' | 'required';

export type ProviderRetentionClass =
  | 'process_only'
  | 'provider_terms'
  | 'provider_declared';

export type ProviderModality = 'text' | 'audio_input' | 'audio_output' | 'vision';

export type ProviderPriceKind = 'zero' | 'fixed' | 'dynamic' | 'unknown';

interface ProviderPricingBase {
  /** Exact integer accounting unit. */
  unit: 'nano_usd';
}

export type ProviderPricingCapability =
  | (ProviderPricingBase & {
    kind: 'zero';
    source: 'local_runtime';
  })
  | (ProviderPricingBase & {
    kind: 'fixed' | 'dynamic';
    source: 'static_registry' | 'provider_catalog';
    inputNanoUsdPerMillionTokens: number;
    outputNanoUsdPerMillionTokens: number;
    /** ISO-8601 timestamp at which the price was checked. */
    checkedAt: string;
    /** A dynamic price is unusable for unattended spend after this instant. */
    expiresAt: string | null;
  })
  | (ProviderPricingBase & {
    kind: 'unknown';
    source: 'unknown';
    reason: 'not_reported' | 'stale' | 'unbounded';
  });

export interface ProviderRetentionDisclosure {
  classification: ProviderRetentionClass;
  /** Plain disclosure suitable for presenting before a remote mode is chosen. */
  summary: string;
  policyUrl: string | null;
}

export interface ProviderPrivacyCapabilities {
  executionLocation: ProviderExecutionLocation;
  networkScope: ProviderNetworkScope;
  confidentiality: ProviderConfidentiality;
  attestationPolicy: ProviderAttestationPolicy;
  retention: ProviderRetentionDisclosure;
  modalities: readonly ProviderModality[];
  pricing: ProviderPricingCapability;
}

/** User-facing routing policy. The mode is independent of provider identity. */
export type ReasoningMode =
  | 'on_device'
  | 'verified_private_cloud'
  | 'bring_your_own_provider';

export const REASONING_MODES: readonly ReasoningMode[] = Object.freeze([
  'on_device',
  'verified_private_cloud',
  'bring_your_own_provider',
]);

export function parseReasoningMode(value: unknown): ReasoningMode | null {
  return typeof value === 'string' && REASONING_MODES.includes(value as ReasoningMode)
    ? (value as ReasoningMode)
    : null;
}

export type ProviderVerificationStatus =
  | 'not_applicable'
  | 'required_missing'
  | 'verified'
  | 'failed';

export interface ProviderRequestIdentity {
  /** SkyTwin-generated identity for this exact invocation. */
  invocationId: string;
  /** Provider-issued identity, when the provider exposes one. Never fabricated. */
  providerRequestId: string | null;
}

export interface ProviderCostBasis {
  pricing: ProviderPricingCapability;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ProviderExecutionAttempt {
  provider: string;
  executionLocation: ProviderExecutionLocation;
  networkScope: ProviderNetworkScope;
  confidentiality: ProviderConfidentiality;
  outcome: 'succeeded' | 'failed' | 'circuit_open' | 'price_unavailable';
}

/** Metadata that remains attached to a normalized provider result. */
export interface ProviderExecutionMetadata {
  reasoningMode: ReasoningMode;
  provider: string;
  model: string;
  request: ProviderRequestIdentity;
  capabilities: ProviderPrivacyCapabilities;
  verificationStatus: ProviderVerificationStatus;
  /** Sanitized ordered path; contains no prompt, credential, or provider error text. */
  executionPath: readonly ProviderExecutionAttempt[];
  costBasis: ProviderCostBasis;
  /** Durable receipt linkage is populated by receipt persistence, never guessed. */
  receiptId: string | null;
}
