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
  | 'ollama_cloud_model'
  | 'ollama_local_source_unverified'
  | 'ollama_structured_output_invalid'
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
  trustedrouter: 'https://trustedrouter.com/privacy',
  nearai: 'https://near.ai/privacy-policy',
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
        : 'Prompt processing is sent over loopback with Ollama local-model resolution enforced; logging and retention depend on the local operator configuration.',
      policyUrl: null,
    },
    modalities: ['text'],
    pricing: { kind: 'zero', unit: 'nano_usd', source: 'local_runtime' },
  };
}

const PROVIDER_NAMES = new Set<AIProviderName>([
  'anthropic', 'openai', 'google', 'ollama', 'embedded', 'trustedrouter', 'nearai',
]);

function snapshotProvider(provider: ProviderEntry): ProviderEntry {
  const allowedKeys = new Set(['name', 'apiKey', 'model', 'baseUrl']);
  const ownKeys = Reflect.ownKeys(provider);
  const name = provider.name;
  const apiKey = provider.apiKey;
  const model = provider.model;
  const baseUrl = provider.baseUrl;
  if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
      || !PROVIDER_NAMES.has(name)
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

export function isExplicitOllamaCloudModel(model: string): boolean {
  const normalized = model.trim();
  const lastSlash = normalized.lastIndexOf('/');
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon <= lastSlash) return false;
  const tag = normalized.slice(lastColon + 1).trim().toLowerCase();
  return tag === 'cloud' || tag.endsWith('-cloud');
}

/**
 * Add Ollama's request-scoped local source selector without changing the
 * configured model identity retained in SkyTwin metadata. Modern Ollama
 * rejects remote-backed aliases under this selector. Older runtimes may treat
 * it as a missing tag; callers must never retry with the unqualified name.
 */
export function ollamaLocalModelReference(model: string): string {
  const normalized = model.trim();
  if (isExplicitOllamaCloudModel(normalized)) {
    throw new ProviderModePolicyError(
      'ollama_cloud_model',
      'Ollama Cloud models are not eligible for on-device reasoning',
      'ollama',
    );
  }
  const lastSlash = normalized.lastIndexOf('/');
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon > lastSlash
      && normalized.slice(lastColon + 1).trim().toLowerCase() === 'local') {
    return `${normalized.slice(0, lastColon)}:local`;
  }
  return `${normalized}:local`;
}

/**
 * Derive disclosure from the concrete adapter. Callers cannot provide their
 * own confidentiality label, and a custom OpenAI-compatible URL therefore
 * remains a conventional remote service.
 */
export function providerPrivacyCapabilities(
  provider: ProviderEntry,
  reasoningMode: ReasoningMode | null = null,
): ProviderPrivacyCapabilities {
  if (provider.name === 'embedded') {
    return localCapabilities('embedded');
  }
  if (provider.name === 'trustedrouter') {
    return {
      executionLocation: 'remote_service',
      networkScope: 'external',
      confidentiality: 'attested_tee',
      attestationPolicy: 'required',
      retention: {
        classification: 'provider_declared',
        summary: 'SkyTwin verifies the attested gateway session and exact-byte receipt; the selected upstream route must independently report a TEE-verified confidential tier.',
        policyUrl: RETENTION_POLICIES.trustedrouter,
      },
      modalities: ['text'],
      pricing: {
        kind: 'unknown',
        unit: 'nano_usd',
        source: 'unknown',
        reason: 'not_reported',
      },
    };
  }
  if (provider.name === 'nearai') {
    return {
      executionLocation: 'remote_service',
      networkScope: 'external',
      confidentiality: 'provider_standard',
      attestationPolicy: 'not_applicable',
      retention: {
        classification: 'provider_declared',
        summary: 'Unavailable: current base-CVM evidence does not pin the dynamically selected model and proxy workload, so SkyTwin does not send prompts through this adapter.',
        policyUrl: RETENTION_POLICIES.nearai,
      },
      modalities: ['text'],
      pricing: {
        kind: 'unknown',
        unit: 'nano_usd',
        source: 'unknown',
        reason: 'not_reported',
      },
    };
  }
  // A local socket alone is not a local-inference guarantee: Ollama can relay
  // cloud models through its loopback API. The on-device client source-
  // qualifies each request as local. Other modes remain conservatively
  // remote/unknown even when they point at loopback.
  if (reasoningMode === 'on_device'
      && isLoopbackOllama(provider)
      && !isExplicitOllamaCloudModel(provider.model)) {
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
  if (provider.name === 'ollama' && isExplicitOllamaCloudModel(provider.model)) {
    throw new ProviderModePolicyError(
      'ollama_cloud_model',
      'Ollama Cloud models are not eligible for on-device reasoning',
      provider.name,
    );
  }
}

function assertConfiguredProvider(provider: ProviderEntry): void {
  // The embedded adapter has no network path and can only truthfully report
  // on-device execution. Reject the mode mismatch before prompt processing;
  // a post-response classification failure would be too late.
  if (provider.name === 'embedded' || provider.name === 'trustedrouter' || provider.name === 'nearai') {
    throw new ProviderModePolicyError(
      'cross_mode_provider',
      provider.name === 'embedded'
        ? 'The embedded provider is eligible only for on-device reasoning'
        : `${provider.name} is eligible only for verified private-cloud reasoning`,
      provider.name,
    );
  }
}

function assertVerifiedProvider(provider: ProviderEntry): void {
  if (provider.name === 'nearai') {
    throw new ProviderModePolicyError(
      'verification_adapter_required',
      'NEAR AI remains unavailable because its base-CVM attestation does not pin the dynamically selected inference workload',
      provider.name,
    );
  }
  if (provider.name !== 'trustedrouter') {
    throw new ProviderModePolicyError(
      'verification_adapter_required',
      `Provider ${provider.name} has no verifier-owned private-cloud adapter`,
      provider.name,
    );
  }
  if (provider.baseUrl !== undefined) {
    throw new ProviderModePolicyError(
      'verification_adapter_required',
      `${provider.name} confidential mode uses only its pinned production endpoint`,
      provider.name,
    );
  }
  if (provider.model.trim() === '') {
    throw new ProviderModePolicyError(
      'invalid_provider',
      `${provider.name} confidential mode requires a model`,
      provider.name,
    );
  }
  if (provider.model !== 'trustedrouter/confidential') {
    throw new ProviderModePolicyError(
      'invalid_provider',
      'TrustedRouter confidential mode requires the pinned confidential route',
      provider.name,
    );
  }
}

/**
 * Validate a provider chain before constructing an LLM client. This function
 * rejects a mixed chain instead of silently filtering it: a configuration
 * mistake must not change where a prompt is sent.
 *
 * Only the verifier-owned TrustedRouter adapter is currently admitted to
 * `verified_private_cloud`. NEAR AI remains represented but unavailable until
 * its dynamic inference workload can be pinned. HTTPS or a custom base URL is
 * never proof.
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
    providerSnapshot.forEach(assertVerifiedProvider);
  } else if (mode === 'on_device') {
    providerSnapshot.forEach(assertLocalProvider);
  } else {
    providerSnapshot.forEach(assertConfiguredProvider);
  }
  return Object.freeze({ mode, providers: providerSnapshot });
}
