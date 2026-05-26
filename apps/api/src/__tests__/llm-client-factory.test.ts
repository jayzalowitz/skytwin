/**
 * Tests for the LLM client factory helper (getLlmClientFromConfig).
 */
import { describe, it, expect, afterEach } from 'vitest';

// We test the non-caching fresh variant to avoid cross-test contamination.
import {
  getLlmClientFromConfigFresh,
  _resetLlmClientCache,
  buildProviderChain,
} from '../lib/llm-client-factory.js';

afterEach(() => {
  _resetLlmClientCache();
});

describe('getLlmClientFromConfigFresh', () => {
  it('returns null when no provider env vars are set', () => {
    // SKYTWIN_DISABLE_EMBEDDED forces the embedded-runtime gate off so a
    // dev machine with `llama-cli` accidentally on PATH doesn't trick this
    // assertion into thinking the env is configured.
    const env: Record<string, string | undefined> = { SKYTWIN_DISABLE_EMBEDDED: '1' };
    const client = getLlmClientFromConfigFresh(env);
    expect(client).toBeNull();
  });

  it('respects SKYTWIN_DISABLE_EMBEDDED=1 even when binary + model are present', () => {
    // Even if the runtime detection would otherwise find both a binary
    // and a model, the explicit kill switch must win so eval runs against
    // only hosted providers stay reproducible.
    const env: Record<string, string | undefined> = {
      SKYTWIN_DISABLE_EMBEDDED: '1',
      SKYTWIN_LLAMACPP_BIN: '/bin/sh', // exists
      SKYTWIN_LLAMA_MODEL: '/etc/hosts', // exists
    };
    const client = getLlmClientFromConfigFresh(env);
    expect(client).toBeNull();
  });

  it('does NOT add embedded when binary is present but no model is configured', () => {
    // Most dev machines have `llama-cli` on PATH via Homebrew but no
    // SkyTwin model installed. Adding embedded to the chain in that
    // state would make every call walk to a provider that throws
    // NotAvailableError. The gate now requires both binary + model.
    const env: Record<string, string | undefined> = {
      SKYTWIN_LLAMACPP_BIN: '/bin/sh', // exists — pretend it's llama-cli
      // No SKYTWIN_LLAMA_MODEL or SKYTWIN_LLAMA_MODELS pointer.
    };
    const client = getLlmClientFromConfigFresh(env);
    expect(client).toBeNull();
  });

  it('adds embedded provider when both SKYTWIN_LLAMACPP_BIN and SKYTWIN_LLAMA_MODEL exist', () => {
    const env: Record<string, string | undefined> = {
      SKYTWIN_LLAMACPP_BIN: '/bin/sh',
      SKYTWIN_LLAMA_MODEL: '/etc/hosts', // any existing file passes the existsSync check
    };
    const client = getLlmClientFromConfigFresh(env);
    expect(client).not.toBeNull();
    expect(client!.hasProviders).toBe(true);
  });

  it('returns an LlmClient when ANTHROPIC_API_KEY is set', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    };
    const client = getLlmClientFromConfigFresh(env);
    expect(client).not.toBeNull();
    expect(client!.hasProviders).toBe(true);
  });

  it('returns an LlmClient when OPENAI_API_KEY is set', () => {
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: 'test-openai-key',
    };
    const client = getLlmClientFromConfigFresh(env);
    expect(client).not.toBeNull();
    expect(client!.hasProviders).toBe(true);
  });

  it('returns an LlmClient when GOOGLE_API_KEY is set', () => {
    const env: Record<string, string | undefined> = {
      GOOGLE_API_KEY: 'test-google-key',
    };
    const client = getLlmClientFromConfigFresh(env);
    expect(client).not.toBeNull();
  });

  it('returns an LlmClient when OLLAMA_BASE_URL is set (no key needed)', () => {
    const env: Record<string, string | undefined> = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
    };
    const client = getLlmClientFromConfigFresh(env);
    expect(client).not.toBeNull();
  });

  it('includes multiple providers when multiple keys are set', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'key-1',
      OPENAI_API_KEY: 'key-2',
    };
    const client = getLlmClientFromConfigFresh(env);
    expect(client).not.toBeNull();
    expect(client!.hasProviders).toBe(true);
  });

  it('uses custom model when ANTHROPIC_MODEL env var is set', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_MODEL: 'claude-3-opus-20240229',
    };
    // Just verify it doesn't throw and returns a client
    const client = getLlmClientFromConfigFresh(env);
    expect(client).not.toBeNull();
  });
});

describe('buildProviderChain — ordering (#375)', () => {
  it('default: local-first — embedded + ollama come BEFORE every cloud provider', () => {
    const env: Record<string, string | undefined> = {
      // Every provider configured. The order in the env doesn't matter;
      // the factory always returns local first by default.
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'o',
      GOOGLE_API_KEY: 'g',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SKYTWIN_LLAMACPP_BIN: '/bin/sh',
      SKYTWIN_LLAMA_MODEL: '/etc/hosts',
    };
    const names = buildProviderChain(env).map((p) => p.name);
    expect(names).toEqual(['embedded', 'ollama', 'anthropic', 'openai', 'google']);
  });

  it('opt-in cloud-first: SKYTWIN_LLM_PRIORITY=cloud-first puts cloud bucket before local bucket', () => {
    // Each bucket keeps its OWN canonical sub-order — cloud is always
    // anthropic → openai → google, local is always embedded → ollama,
    // regardless of the priority flag. This is NOT a bit-for-bit
    // restoration of the pre-#375 legacy chain (legacy had ollama
    // before embedded); the local sub-order is the same one used in
    // local-first mode for consistency.
    const env: Record<string, string | undefined> = {
      SKYTWIN_LLM_PRIORITY: 'cloud-first',
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'o',
      GOOGLE_API_KEY: 'g',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SKYTWIN_LLAMACPP_BIN: '/bin/sh',
      SKYTWIN_LLAMA_MODEL: '/etc/hosts',
    };
    const names = buildProviderChain(env).map((p) => p.name);
    expect(names).toEqual(['anthropic', 'openai', 'google', 'embedded', 'ollama']);
  });

  it('unknown / typo SKYTWIN_LLM_PRIORITY values fall back to local-first (privacy-preserving default)', () => {
    // A typo (`SKYTWIN_LLM_PRIORITY=clouf-first`) must NOT silently
    // escalate to cloud — that would defeat the whole point. Falls back
    // to the safer ordering instead.
    const env: Record<string, string | undefined> = {
      SKYTWIN_LLM_PRIORITY: 'clouf-first',
      ANTHROPIC_API_KEY: 'a',
      OLLAMA_BASE_URL: 'http://localhost:11434',
    };
    const names = buildProviderChain(env).map((p) => p.name);
    expect(names[0]).toBe('ollama');
  });

  it('case-insensitive on the SKYTWIN_LLM_PRIORITY value', () => {
    const env: Record<string, string | undefined> = {
      SKYTWIN_LLM_PRIORITY: 'CLOUD-FIRST',
      ANTHROPIC_API_KEY: 'a',
      OLLAMA_BASE_URL: 'http://localhost:11434',
    };
    const names = buildProviderChain(env).map((p) => p.name);
    expect(names).toEqual(['anthropic', 'ollama']);
  });

  it('empty SKYTWIN_LLM_PRIORITY is treated as local-first (the default)', () => {
    const env: Record<string, string | undefined> = {
      SKYTWIN_LLM_PRIORITY: '',
      ANTHROPIC_API_KEY: 'a',
      OLLAMA_BASE_URL: 'http://localhost:11434',
    };
    const names = buildProviderChain(env).map((p) => p.name);
    expect(names).toEqual(['ollama', 'anthropic']);
  });

  it('returns empty array when no providers are configured (regardless of priority)', () => {
    const env: Record<string, string | undefined> = {
      SKYTWIN_DISABLE_EMBEDDED: '1',
    };
    expect(buildProviderChain(env)).toEqual([]);
    expect(buildProviderChain({ ...env, SKYTWIN_LLM_PRIORITY: 'cloud-first' })).toEqual([]);
  });

  it('only-cloud configuration: chain is just the cloud providers in their own canonical order', () => {
    const env: Record<string, string | undefined> = {
      SKYTWIN_DISABLE_EMBEDDED: '1',
      ANTHROPIC_API_KEY: 'a',
      GOOGLE_API_KEY: 'g',
    };
    // No local providers, so local-first vs cloud-first produce the
    // same result — but the cloud sub-order (anthropic → openai →
    // google) must be stable regardless.
    expect(buildProviderChain(env).map((p) => p.name)).toEqual(['anthropic', 'google']);
    expect(
      buildProviderChain({ ...env, SKYTWIN_LLM_PRIORITY: 'cloud-first' }).map((p) => p.name),
    ).toEqual(['anthropic', 'google']);
  });

  it('only-local configuration: chain is just embedded + ollama in their own canonical order', () => {
    const env: Record<string, string | undefined> = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SKYTWIN_LLAMACPP_BIN: '/bin/sh',
      SKYTWIN_LLAMA_MODEL: '/etc/hosts',
    };
    expect(buildProviderChain(env).map((p) => p.name)).toEqual(['embedded', 'ollama']);
  });
});
