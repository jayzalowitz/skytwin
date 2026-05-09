/**
 * Unit tests for the memory backend factory (#197).
 *
 * Verifies:
 *   - Default backend is 'gbrain' (issue #197 user direction).
 *   - MEMORY_BACKEND env var overrides the default.
 *   - Per-user brain_settings override the env default.
 *   - Embedding provider selection: OpenAI when API key present, hash
 *     fallback otherwise.
 *   - The hybrid factory wires both ports + returns the diagnostics-aware
 *     hybrid handle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSettings } = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
}));

vi.mock('@skytwin/memory-gbrain-crdb-adapter', async () => {
  const actual: typeof import('@skytwin/memory-gbrain-crdb-adapter') =
    await vi.importActual('@skytwin/memory-gbrain-crdb-adapter');
  return {
    ...actual,
    getSettings: mockGetSettings,
    upsertSettings: vi.fn(),
  };
});

vi.mock('@skytwin/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  getMemoryPortForUser,
  getEmbeddingProvider,
  defaultRoutingRules,
  suggestHybridUpgrade,
  _resetEmbeddingCacheForTests,
} from '../memory-setup.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettings.mockResolvedValue(null);
  delete process.env['MEMORY_BACKEND'];
  delete process.env['OPENAI_EMBEDDING_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  _resetEmbeddingCacheForTests();
});

describe('getMemoryPortForUser', () => {
  it('defaults to gbrain when no env or per-user override', async () => {
    const r = await getMemoryPortForUser(USER_ID);
    expect(r.backend).toBe('gbrain');
    expect(r.hybrid).toBeNull();
    expect(r.port.capabilities().has('semantic_search')).toBe(true);
  });

  it('honours MEMORY_BACKEND=hybrid', async () => {
    process.env['MEMORY_BACKEND'] = 'hybrid';
    const r = await getMemoryPortForUser(USER_ID);
    expect(r.backend).toBe('hybrid');
    expect(r.hybrid).not.toBeNull();
  });

  it('honours MEMORY_BACKEND=mempalace', async () => {
    process.env['MEMORY_BACKEND'] = 'mempalace';
    const r = await getMemoryPortForUser(USER_ID);
    expect(r.backend).toBe('mempalace');
  });

  it('per-user override beats the env default', async () => {
    process.env['MEMORY_BACKEND'] = 'gbrain';
    mockGetSettings.mockResolvedValue({
      user_id: USER_ID,
      backend: 'hybrid',
      hybrid_notification_dismissed: false,
      routing: {},
      updated_at: new Date(),
    });
    const r = await getMemoryPortForUser(USER_ID);
    expect(r.backend).toBe('hybrid');
  });

  it('falls back to env default when getSettings throws', async () => {
    process.env['MEMORY_BACKEND'] = 'gbrain';
    mockGetSettings.mockRejectedValue(new Error('db down'));
    const r = await getMemoryPortForUser(USER_ID);
    expect(r.backend).toBe('gbrain');
  });

  it('hybrid mode declares the union of capabilities', async () => {
    process.env['MEMORY_BACKEND'] = 'hybrid';
    const r = await getMemoryPortForUser(USER_ID);
    const caps = r.port.capabilities();
    expect(caps.has('semantic_search')).toBe(true);
    expect(caps.has('spatial_wings')).toBe(true);
    expect(caps.has('aaak_compression')).toBe(true);
  });

  it('hybrid diagnostics handle is exposed when active', async () => {
    process.env['MEMORY_BACKEND'] = 'hybrid';
    const r = await getMemoryPortForUser(USER_ID);
    expect(r.hybrid).not.toBeNull();
    expect(r.hybrid?.getDiagnostics()).toEqual({
      routedPrimary: 0,
      routedSecondary: 0,
      writesPrimaryOk: 0,
      writesSecondaryOk: 0,
      writesSecondaryFailed: 0,
      writesPrimaryFailed: 0,
    });
  });
});

describe('getEmbeddingProvider', () => {
  it('returns hash provider when no env keys are set', () => {
    const p = getEmbeddingProvider();
    expect(p.model).toBe('hash-fnv1a-v1');
  });

  it('returns OpenAI provider when OPENAI_EMBEDDING_API_KEY is set', () => {
    process.env['OPENAI_EMBEDDING_API_KEY'] = 'sk-test';
    const p = getEmbeddingProvider();
    expect(p.model).toBe('text-embedding-3-small');
  });

  it('falls back to OPENAI_API_KEY when EMBEDDING-specific key is missing', () => {
    process.env['OPENAI_API_KEY'] = 'sk-shared';
    const p = getEmbeddingProvider();
    expect(p.model).toBe('text-embedding-3-small');
  });

  it('respects OPENAI_EMBEDDING_MODEL', () => {
    process.env['OPENAI_EMBEDDING_API_KEY'] = 'sk-test';
    process.env['OPENAI_EMBEDDING_MODEL'] = 'text-embedding-3-large';
    const p = getEmbeddingProvider();
    expect(p.model).toBe('text-embedding-3-large');
    delete process.env['OPENAI_EMBEDDING_MODEL'];
  });
});

describe('defaultRoutingRules', () => {
  it('routes semantic + code + graph + episodes + triples to primary (gbrain has them all natively); summarize/compress to secondary (mempalace AAAK)', () => {
    const rules = defaultRoutingRules();
    expect(rules.searchSemantic).toBe('primary');
    expect(rules.code_aware_search).toBe('primary');
    expect(rules.walkGraph).toBe('primary');
    expect(rules.getTriples).toBe('primary');
    expect(rules.getEpisodes).toBe('primary');
    expect(rules.summarize).toBe('secondary');
    expect(rules.compress).toBe('secondary');
  });
});

describe('suggestHybridUpgrade', () => {
  it('returns shape with three booleans', () => {
    const s = suggestHybridUpgrade();
    expect(typeof s.suggest).toBe('boolean');
    expect(typeof s.externalConfigPresent).toBe('boolean');
    expect(typeof s.cliInPath).toBe('boolean');
  });
});
