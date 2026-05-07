/**
 * Tests for the LLM client factory helper (getLlmClientFromConfig).
 */
import { describe, it, expect, afterEach } from 'vitest';

// We test the non-caching fresh variant to avoid cross-test contamination.
import { getLlmClientFromConfigFresh, _resetLlmClientCache } from '../lib/llm-client-factory.js';

afterEach(() => {
  _resetLlmClientCache();
});

describe('getLlmClientFromConfigFresh', () => {
  it('returns null when no provider env vars are set', () => {
    const env: Record<string, string | undefined> = {};
    const client = getLlmClientFromConfigFresh(env);
    expect(client).toBeNull();
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
