import type {
  AIProviderName,
  ProviderPricingCapability,
  ProviderPrivacyCapabilities,
  ReasoningMode,
} from '@skytwin/shared-types';
import { parseReasoningMode } from '@skytwin/shared-types';
import type { ProviderEntry } from './types.js';
import { isLoopbackHostname } from './url-validation.js';

export type ProviderModePolicyErrorCode =
  | 'unknown_mode'
  | 'no_providers'
  | 'invalid_provider'
  | 'cross_mode_provider'
  | 'non_loopback_local_endpoint'
  | 'verification_adapter_required';

export class ProviderModePolicyError extends Error {
  constructor(
    readonly code: ProviderModePolicyErrorCode,
    message: string,
    readonly provider: AIProviderName | null = null,
  ) {
    super(message);
    this.name = 'ProviderModePolicyError';
  }
}

const RETENTION_POLICIES: Readonly<Record<AIProviderName, string | null>> = {
  anthropic: 'https://www.anthropic.com/legal/commercial-terms',
  openai: 'https://openai.com/policies/business-terms/',
  google: 'https://ai.google.dev/gemini-api/terms',
  ollama: null,
  embedded: null,
};

function localCapabilities(provider: 'embedded' | 'ollama'): ProviderPrivacyCapabilities {
  return {
    executionLocation: 'on_device',
    networkScope: provider === 'embedded' ? 'none' : 'loopback',
    confidentiality: 'device_local',
    attestationPolicy: 'not_applicable',
    retention: {
      classification: provider === 'embedded' ? 'local_runtime' : 'operator_unknown',
      summary: provider === 'embedded'
        ? 'Prompt processing uses a model subprocess on this device; no remote-provider retention policy applies.'
        : 'Prompt processing is sent over loopback to the configured Ollama service; its logging and retention depend on the local operator configuration.',
      policyUrl: null,
    },
    modalities: ['text'],
    pricing: { kind: 'zero', unit: 'nano_usd', source: 'local_runtime' },
  };
}

const PROVIDER_NAMES = new Set<AIProviderName>([
  'anthropic', 'openai', 'google', 'ollama', 'embedded',
]);

function snapshotProvider(provider: ProviderEntry): ProviderEntry {
  const name = provider.name;
  const apiKey = provider.apiKey;
  const model = provider.model;
  const baseUrl = provider.baseUrl;
  if (!PROVIDER_NAMES.has(name)
      || typeof apiKey !== 'string'
      || typeof model !== 'string'
      || (baseUrl !== undefined && typeof baseUrl !== 'string')) {
    throw new ProviderModePolicyError(
      'invalid_provider',
      'Provider configuration must contain only canonical scalar fields',
      PROVIDER_NAMES.has(name) ? name : null,
    );
  }
  return Object.freeze(baseUrl === undefined
    ? { name, apiKey, model }
    : { name, apiKey, model, baseUrl });
}

function snapshotProviders(providers: readonly ProviderEntry[]): readonly ProviderEntry[] {
  const length = providers.length;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new ProviderModePolicyError(
      'invalid_provider',
      'Provider chain length is invalid',
    );
  }
  const snapshot: ProviderEntry[] = [];
  for (let index = 0; index < length; index += 1) {
    snapshot.push(snapshotProvider(providers[index]!));
  }
  return Object.freeze(snapshot);
}

function isLoopbackOllama(provider: ProviderEntry): boolean {
  if (provider.name !== 'ollama') return false;
  if (!provider.baseUrl) return true;
  try {
    const url = new URL(provider.baseUrl);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
      && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Derive disclosure from the concrete adapter. Callers cannot provide their
 * own confidentiality label, and a custom OpenAI-compatible URL therefore
 * remains a conventional remote service.
 */
export function providerPrivacyCapabilities(provider: ProviderEntry): ProviderPrivacyCapabilities {
  if (provider.name === 'embedded') {
    return localCapabilities('embedded');
  }
  if (isLoopbackOllama(provider)) {
    return localCapabilities('ollama');
  }
  const isUserDirectedEndpoint = provider.name === 'ollama' || Boolean(provider.baseUrl);
  return {
    executionLocation: 'remote_service',
    networkScope: 'external',
    confidentiality: isUserDirectedEndpoint ? 'operator_declared' : 'provider_standard',
    attestationPolicy: 'not_applicable',
    retention: {
      classification: isUserDirectedEndpoint ? 'provider_declared' : 'provider_terms',
      summary: isUserDirectedEndpoint
        ? 'Prompt and response handling follows the operator of the configured remote endpoint.'
        : 'Prompt and response handling follows the selected provider terms.',
      policyUrl: isUserDirectedEndpoint ? null : RETENTION_POLICIES[provider.name],
    },
    modalities: ['text'],
    // Model-specific remote pricing is not established by this configuration.
    // Unknown must never be rendered or enforced as zero.
    pricing: {
      kind: 'unknown',
      unit: 'nano_usd',
      source: 'unknown',
      reason: 'not_reported',
    },
  };
}

/**
 * A single fail-closed predicate for any inference that can run without an
 * explicit user action. Malformed timestamps are unavailable, not immortal.
 */
export function isPricingUsableForUnattended(
  pricing: ProviderPricingCapability,
  nowMs = Date.now(),
): boolean {
  if (pricing.kind === 'zero') return true;
  if (pricing.kind === 'unknown') return false;
  if (!Number.isSafeInteger(pricing.inputNanoUsdPerMillionTokens)
      || pricing.inputNanoUsdPerMillionTokens < 0
      || !Number.isSafeInteger(pricing.outputNanoUsdPerMillionTokens)
      || pricing.outputNanoUsdPerMillionTokens < 0
      || !Number.isFinite(Date.parse(pricing.checkedAt))) {
    return false;
  }
  if (pricing.expiresAt === null) return pricing.kind === 'fixed';
  const expiresAt = Date.parse(pricing.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

function assertLocalProvider(provider: ProviderEntry): void {
  if (provider.name !== 'embedded' && provider.name !== 'ollama') {
    throw new ProviderModePolicyError(
      'cross_mode_provider',
      `Provider ${provider.name} is not eligible for on-device reasoning`,
      provider.name,
    );
  }
  if (provider.name === 'ollama' && !isLoopbackOllama(provider)) {
    throw new ProviderModePolicyError(
      'non_loopback_local_endpoint',
      'On-device reasoning permits only a valid loopback Ollama endpoint',
      provider.name,
    );
  }
}

/**
 * Validate a provider chain before constructing an LLM client. This function
 * rejects a mixed chain instead of silently filtering it: a configuration
 * mistake must not change where a prompt is sent.
 *
 * No current adapter is admitted to `verified_private_cloud`; issue #640 adds
 * the verifier-owned adapter boundary. HTTPS or a custom base URL is not proof.
 */
export function providersForReasoningMode(
  rawMode: unknown,
  providers: readonly ProviderEntry[],
): Readonly<{ mode: ReasoningMode; providers: readonly ProviderEntry[] }> {
  const mode = parseReasoningMode(rawMode);
  if (!mode) {
    throw new ProviderModePolicyError('unknown_mode', 'A canonical reasoning mode is required');
  }
  const providerSnapshot = snapshotProviders(providers);
  if (providerSnapshot.length === 0) {
    throw new ProviderModePolicyError('no_providers', `No providers are configured for ${mode}`);
  }
  if (mode === 'verified_private_cloud') {
    throw new ProviderModePolicyError(
      'verification_adapter_required',
      'Verified private cloud requires a verifier-owned provider adapter',
    );
  }
  if (mode === 'on_device') {
    providerSnapshot.forEach(assertLocalProvider);
  }
  return Object.freeze({ mode, providers: providerSnapshot });
}
