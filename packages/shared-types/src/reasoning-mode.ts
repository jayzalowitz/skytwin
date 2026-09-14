import type { AIProviderName } from './ai-provider.js';

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
  | 'local_runtime'
  | 'operator_unknown'
  | 'provider_terms'
  | 'provider_declared';

export type ProviderModality = 'text' | 'audio_input' | 'audio_output' | 'vision';

export type ProviderPriceKind = 'zero' | 'fixed' | 'dynamic' | 'unknown';

interface ProviderPricingBase {
  /** Exact integer accounting unit. */
  readonly unit: 'nano_usd';
}

export type ProviderPricingCapability =
  | (ProviderPricingBase & {
    readonly kind: 'zero';
    readonly source: 'local_runtime';
  })
  | (ProviderPricingBase & {
    readonly kind: 'fixed' | 'dynamic';
    readonly source: 'static_registry' | 'provider_catalog';
    readonly inputNanoUsdPerMillionTokens: number;
    readonly outputNanoUsdPerMillionTokens: number;
    /** ISO-8601 timestamp at which the price was checked. */
    readonly checkedAt: string;
    /** A dynamic price is unusable for unattended spend after this instant. */
    readonly expiresAt: string | null;
  })
  | (ProviderPricingBase & {
    readonly kind: 'unknown';
    readonly source: 'unknown';
    readonly reason: 'not_reported' | 'stale' | 'unbounded';
  });

export interface ProviderRetentionDisclosure {
  readonly classification: ProviderRetentionClass;
  /** Plain disclosure suitable for presenting before a remote mode is chosen. */
  readonly summary: string;
  readonly policyUrl: string | null;
}

export interface ProviderPrivacyCapabilities {
  readonly executionLocation: ProviderExecutionLocation;
  readonly networkScope: ProviderNetworkScope;
  readonly confidentiality: ProviderConfidentiality;
  readonly attestationPolicy: ProviderAttestationPolicy;
  readonly retention: ProviderRetentionDisclosure;
  readonly modalities: readonly ProviderModality[];
  readonly pricing: ProviderPricingCapability;
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

/**
 * Canonical persisted representation for a caller-supplied provider base URL.
 * WHATWG URL parsing collapses alternate IPv4 and IPv6 spellings; removing a
 * DNS root dot keeps database compatibility checks aligned with transport.
 */
export function canonicalizeProviderBaseUrl(
  baseUrl: string | null | undefined,
): string | undefined {
  if (baseUrl === null || baseUrl === undefined || baseUrl.length === 0) return undefined;
  const parsed = new URL(baseUrl);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0
      || parsed.password.length > 0) {
    throw new Error('Provider endpoint must be an HTTP(S) URL without embedded credentials');
  }
  if (parsed.hostname.endsWith('.')) {
    parsed.hostname = parsed.hostname.slice(0, -1);
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('Provider endpoint must not include a query string or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (parsed.pathname === '/') {
    return parsed.origin;
  }
  return parsed.toString();
}

/**
 * Canonical network authority used to decide whether a persisted credential
 * may be reused. Paths may change without changing who receives the secret;
 * scheme, host, or effective port changes require a fresh credential.
 *
 * An omitted Ollama URL means the adapter's fixed loopback default. Other
 * omitted URLs remain provider-owned defaults and are deliberately distinct
 * from every caller-supplied endpoint.
 */
export function providerCredentialEndpointAuthority(
  provider: AIProviderName,
  baseUrl: string | null | undefined,
): string {
  if (baseUrl === null || baseUrl === undefined || baseUrl.length === 0) {
    return provider === 'ollama'
      ? 'http://127.0.0.1:11434'
      : `provider-default:${provider}`;
  }
  return new URL(canonicalizeProviderBaseUrl(baseUrl)!).origin;
}

export function hasSameProviderCredentialEndpoint(
  provider: AIProviderName,
  previousBaseUrl: string | null | undefined,
  nextBaseUrl: string | null | undefined,
): boolean {
  try {
    return providerCredentialEndpointAuthority(provider, previousBaseUrl)
      === providerCredentialEndpointAuthority(provider, nextBaseUrl);
  } catch {
    return false;
  }
}

export type ProviderVerificationStatus =
  | 'not_applicable'
  | 'required_missing'
  | 'verified'
  | 'failed';

export interface ProviderRequestIdentity {
  /** SkyTwin-generated identity for this exact invocation. */
  readonly invocationId: string;
  /** Provider-issued identity, when the provider exposes one. Never fabricated. */
  readonly providerRequestId: string | null;
}

export interface ProviderCostBasis {
  readonly pricing: ProviderPricingCapability;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface ProviderExecutionAttempt {
  readonly provider: string;
  readonly outcome: 'succeeded' | 'failed' | 'circuit_open' | 'price_unavailable';
}

/** Metadata that remains attached to a normalized provider result. */
export interface ProviderExecutionMetadata {
  readonly reasoningMode: ReasoningMode;
  readonly provider: string;
  readonly model: string;
  readonly request: ProviderRequestIdentity;
  readonly capabilities: ProviderPrivacyCapabilities;
  readonly verificationStatus: ProviderVerificationStatus;
  /** Sanitized ordered path; contains no prompt, credential, or provider error text. */
  readonly executionPath: readonly ProviderExecutionAttempt[];
  readonly costBasis: ProviderCostBasis;
  /** Durable receipt linkage is populated by receipt persistence, never guessed. */
  readonly receiptId: string | null;
}
