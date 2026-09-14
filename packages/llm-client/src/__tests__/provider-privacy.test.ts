import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '../types.js';
import {
  isPricingUsableForUnattended,
  providerPrivacyCapabilities,
  providersForReasoningMode,
} from '../provider-privacy.js';

const embedded: ProviderEntry = { name: 'embedded', apiKey: '', model: 'managed' };
const ollama: ProviderEntry = {
  name: 'ollama', apiKey: '', model: 'qwen', baseUrl: 'http://127.0.0.1:11434',
};
const openai: ProviderEntry = { name: 'openai', apiKey: 'secret', model: 'gpt' };

describe('provider privacy capabilities', () => {
  it('derives local boundaries from concrete local adapters', () => {
    expect(providerPrivacyCapabilities(embedded)).toMatchObject({
      executionLocation: 'on_device',
      networkScope: 'none',
      confidentiality: 'device_local',
      retention: { classification: 'local_runtime' },
      pricing: { kind: 'zero' },
    });
    expect(providerPrivacyCapabilities(ollama, 'on_device')).toMatchObject({
      executionLocation: 'on_device',
      networkScope: 'loopback',
      confidentiality: 'device_local',
      retention: { classification: 'operator_unknown' },
      pricing: { kind: 'zero' },
    });
  });

  it('uses transport hostname normalization for loopback disclosure', () => {
    const trailingDotLocalhost = { ...ollama, baseUrl: 'http://localhost.:11434' };
    expect(providerPrivacyCapabilities(trailingDotLocalhost, 'on_device')).toMatchObject({
      executionLocation: 'on_device',
      networkScope: 'loopback',
      confidentiality: 'device_local',
    });
    expect(providersForReasoningMode('on_device', [trailingDotLocalhost])).toEqual({
      mode: 'on_device', providers: [trailingDotLocalhost],
    });
  });

  it('does not infer confidential computing or zero cost from a custom URL', () => {
    const custom = { ...openai, baseUrl: 'https://private.example/v1' };
    expect(providerPrivacyCapabilities(custom)).toMatchObject({
      executionLocation: 'remote_service',
      networkScope: 'external',
      confidentiality: 'operator_declared',
      attestationPolicy: 'not_applicable',
      pricing: { kind: 'unknown' },
      retention: { classification: 'provider_declared', policyUrl: null },
    });
  });

  it('classifies a remotely hosted Ollama endpoint as a conventional remote service', () => {
    const remoteOllama = { ...ollama, baseUrl: 'https://ollama.example' };
    expect(providerPrivacyCapabilities(remoteOllama)).toMatchObject({
      executionLocation: 'remote_service',
      networkScope: 'external',
      confidentiality: 'operator_declared',
      pricing: { kind: 'unknown' },
    });
  });

  it('does not claim loopback Ollama is local outside the verified on-device path', () => {
    expect(providerPrivacyCapabilities(ollama, 'bring_your_own_provider')).toMatchObject({
      executionLocation: 'remote_service',
      networkScope: 'external',
      pricing: { kind: 'unknown' },
    });
    expect(providerPrivacyCapabilities({ ...ollama, model: 'qwen3:cloud' }, 'on_device'))
      .toMatchObject({
        executionLocation: 'remote_service',
        networkScope: 'external',
        pricing: { kind: 'unknown' },
      });
  });
});

describe('unattended pricing policy', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const fixed = {
    kind: 'fixed' as const,
    unit: 'nano_usd' as const,
    source: 'static_registry' as const,
    inputNanoUsdPerMillionTokens: 1,
    outputNanoUsdPerMillionTokens: 2,
    checkedAt: '2026-09-10T11:00:00Z',
    expiresAt: null,
  };

  it('accepts local zero pricing and well-formed bounded pricing', () => {
    expect(isPricingUsableForUnattended({
      kind: 'zero', unit: 'nano_usd', source: 'local_runtime',
    }, now)).toBe(true);
    expect(isPricingUsableForUnattended(fixed, now)).toBe(true);
    expect(isPricingUsableForUnattended({
      ...fixed, kind: 'dynamic', source: 'provider_catalog',
      expiresAt: '2026-09-10T13:00:00Z',
    }, now)).toBe(true);
  });

  it('rejects unknown, invalid, stale, and unbounded dynamic pricing', () => {
    expect(isPricingUsableForUnattended({
      kind: 'unknown', unit: 'nano_usd', source: 'unknown', reason: 'not_reported',
    }, now)).toBe(false);
    expect(isPricingUsableForUnattended({ ...fixed, checkedAt: 'not-a-date' }, now)).toBe(false);
    expect(isPricingUsableForUnattended({ ...fixed, expiresAt: 'not-a-date' }, now)).toBe(false);
    expect(isPricingUsableForUnattended({ ...fixed, expiresAt: '2026-09-10T12:00:00Z' }, now)).toBe(false);
    expect(isPricingUsableForUnattended({
      ...fixed, kind: 'dynamic', source: 'provider_catalog', expiresAt: null,
    }, now)).toBe(false);
  });
});

describe('reasoning-mode provider policy', () => {
  it('admits an explicitly local-only chain', () => {
    const admitted = providersForReasoningMode('on_device', [embedded, ollama]);
    expect(admitted).toEqual({
      mode: 'on_device', providers: [embedded, ollama],
    });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.providers)).toBe(true);
    expect(admitted.providers.every(Object.isFrozen)).toBe(true);
  });

  it('snapshots every provider scalar exactly once before validation', () => {
    const reads = { name: 0, apiKey: 0, model: 0, baseUrl: 0 };
    const hostile = Object.defineProperties({}, {
      name: { get: () => (++reads.name === 1 ? 'ollama' : 'openai') },
      apiKey: { get: () => { reads.apiKey += 1; return ''; } },
      model: { get: () => { reads.model += 1; return 'qwen'; } },
      baseUrl: { get: () => { reads.baseUrl += 1; return 'http://127.0.0.1:11434'; } },
    }) as ProviderEntry;

    const admitted = providersForReasoningMode('on_device', [hostile]);

    expect(admitted.providers[0]).toEqual({
      name: 'ollama', apiKey: '', model: 'qwen', baseUrl: 'http://127.0.0.1:11434',
    });
    expect(reads).toEqual({ name: 1, apiKey: 1, model: 1, baseUrl: 1 });
  });

  it('does not retain mutable provider objects after admission', () => {
    const mutable: ProviderEntry = { ...ollama };
    const admitted = providersForReasoningMode('on_device', [mutable]);
    mutable.name = 'openai';
    mutable.apiKey = 'redirected-secret';
    mutable.baseUrl = 'https://remote.example';
    expect(admitted.providers[0]).toEqual(ollama);
  });

  it('rejects remote and non-loopback providers in on-device mode', () => {
    expect(() => providersForReasoningMode('on_device', [embedded, openai]))
      .toThrow(expect.objectContaining({ code: 'cross_mode_provider' }));
    expect(() => providersForReasoningMode('on_device', [{
      ...ollama, baseUrl: 'https://ollama.example',
    }])).toThrow(expect.objectContaining({ code: 'non_loopback_local_endpoint' }));
  });

  it('rejects explicit Ollama Cloud model tags in on-device mode', () => {
    for (const model of [
      'qwen3:cloud',
      'gpt-oss:120b-cloud',
      'model:latest-cloud',
      'QWEN3:CLOUD',
    ]) {
      expect(() => providersForReasoningMode('on_device', [{ ...ollama, model }]))
        .toThrow(expect.objectContaining({ code: 'ollama_cloud_model' }));
    }
  });

  it('does not mistake cloud text outside an Ollama source tag for cloud routing', () => {
    expect(providersForReasoningMode('on_device', [{
      ...ollama, model: 'my-cloud-model',
    }]).providers[0]?.model).toBe('my-cloud-model');
  });

  it('fails closed for unknown modes, empty chains and unverified private-cloud adapters', () => {
    expect(() => providersForReasoningMode('ON_DEVICE', [embedded]))
      .toThrow(expect.objectContaining({ code: 'unknown_mode' }));
    expect(() => providersForReasoningMode('on_device', []))
      .toThrow(expect.objectContaining({ code: 'no_providers' }));
    expect(() => providersForReasoningMode('verified_private_cloud', [openai]))
      .toThrow(expect.objectContaining({ code: 'verification_adapter_required' }));
  });

  it('admits conventional providers only under the explicit bring-your-own mode', () => {
    expect(providersForReasoningMode('bring_your_own_provider', [openai])).toEqual({
      mode: 'bring_your_own_provider', providers: [openai],
    });
  });
});
