import { describe, it, expect, vi, beforeEach } from 'vitest';
import { visibleTools, scopeAllows } from '../auth/scope-filter.js';
import { redactPII } from '../audit/provenance-writer.js';

// Mock the DB repository so we can test tokenStore without a real DB
vi.mock('@skytwin/db', () => ({
  externalAgentTokenRepository: {
    create: vi.fn(),
    findByHash: vi.fn(),
    touchLastUsed: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    listForUser: vi.fn(),
    findById: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── tokenStore ───────────────────────────────────────────────────────────────
describe('tokenStore', () => {
  it('issue: inserts a hashed token row and returns the plaintext token once', async () => {
    const { externalAgentTokenRepository } = await import('@skytwin/db');
    vi.mocked(externalAgentTokenRepository.create).mockResolvedValueOnce({
      id: 'tok-1',
      user_id: 'user-1',
      token_hash: Buffer.alloc(32),
      scope: 'read',
      agent_name: 'claude-desktop',
      issued_at: new Date(),
      revoked_at: null,
      last_used_at: null,
    });

    const { tokenStore } = await import('../auth/token-store.js');
    const result = await tokenStore.issue({
      userId: 'user-1',
      scope: 'read',
      agentName: 'claude-desktop',
    });

    // Plaintext token returned once
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBe(64); // 32 bytes hex
    // Repository was called with a Buffer (the hash), not the raw token
    expect(externalAgentTokenRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        scope: 'read',
        agentName: 'claude-desktop',
        tokenHash: expect.any(Buffer),
      }),
    );
    // The Buffer passed in is NOT equal to the raw token string as bytes
    const callArg = vi.mocked(externalAgentTokenRepository.create).mock.calls[0]![0];
    expect(callArg.tokenHash.toString('hex')).not.toBe(result.token);
  });

  it('lookup: returns null for unknown/revoked tokens', async () => {
    const { externalAgentTokenRepository } = await import('@skytwin/db');
    vi.mocked(externalAgentTokenRepository.findByHash).mockResolvedValueOnce(null);

    const { tokenStore } = await import('../auth/token-store.js');
    const result = await tokenStore.lookup('nonexistent-token');
    expect(result).toBeNull();
  });

  it('lookup: returns token metadata for a valid token', async () => {
    const { externalAgentTokenRepository } = await import('@skytwin/db');
    vi.mocked(externalAgentTokenRepository.findByHash).mockResolvedValueOnce({
      id: 'tok-2',
      user_id: 'user-1',
      token_hash: Buffer.alloc(32),
      scope: 'propose',
      agent_name: 'cursor',
      issued_at: new Date(),
      revoked_at: null,
      last_used_at: null,
    });

    const { tokenStore } = await import('../auth/token-store.js');
    const result = await tokenStore.lookup('some-valid-token');
    expect(result).not.toBeNull();
    expect(result!.scope).toBe('propose');
    expect(result!.agentName).toBe('cursor');
    expect(result!.token).toBe('[redacted]'); // plaintext never returned on lookup
  });

  it('revoke: calls the repository revoke method', async () => {
    const { externalAgentTokenRepository } = await import('@skytwin/db');

    const { tokenStore } = await import('../auth/token-store.js');
    await tokenStore.revoke('tok-99');
    expect(externalAgentTokenRepository.revoke).toHaveBeenCalledWith('tok-99');
  });
});

// ─── scope-filter ─────────────────────────────────────────────────────────────
describe('scopeFilter', () => {
  it('read scope: allows whoami, query_memory, get_preferences', () => {
    expect(scopeAllows('read', 'whoami')).toBe(true);
    expect(scopeAllows('read', 'query_memory')).toBe(true);
    expect(scopeAllows('read', 'get_preferences')).toBe(true);
  });

  it('read scope: blocks propose_action and subscribe_signals', () => {
    expect(scopeAllows('read', 'propose_action')).toBe(false);
    expect(scopeAllows('read', 'subscribe_signals')).toBe(false);
  });

  it('propose scope: allows propose_action but NOT subscribe_signals', () => {
    expect(scopeAllows('propose', 'propose_action')).toBe(true);
    expect(scopeAllows('propose', 'subscribe_signals')).toBe(false);
  });

  it('subscribe scope: allows subscribe_signals but NOT propose_action', () => {
    expect(scopeAllows('subscribe', 'subscribe_signals')).toBe(true);
    expect(scopeAllows('subscribe', 'propose_action')).toBe(false);
  });

  it('visibleTools returns correct set for each scope', () => {
    const readTools = visibleTools('read');
    expect(readTools).toEqual(['whoami', 'query_memory', 'get_preferences']);

    const proposeTools = visibleTools('propose');
    expect(proposeTools).toEqual(['whoami', 'query_memory', 'get_preferences', 'propose_action']);

    const subscribeTools = visibleTools('subscribe');
    expect(subscribeTools).toEqual(['whoami', 'query_memory', 'get_preferences', 'subscribe_signals']);
  });
});

// ─── PII redaction ────────────────────────────────────────────────────────────
describe('redactPII', () => {
  it('strips known PII field names', () => {
    const result = redactPII({ email: 'a@b.com', question: 'how are you?' });
    expect(result['email']).toBe('[REDACTED]');
    expect(result['question']).toBe('how are you?');
  });

  it('redacts nested PII fields', () => {
    const result = redactPII({
      action: { type: 'send_email', parameters: { apiKey: 'secret-key', body: 'hello' } },
    });
    const action = result['action'] as Record<string, unknown>;
    const params = action['parameters'] as Record<string, unknown>;
    expect(params['apiKey']).toBe('[REDACTED]');
    expect(params['body']).toBe('hello');
  });

  it('does not mutate the input object', () => {
    const input = { email: 'test@test.com', name: 'Alice' };
    redactPII(input);
    expect(input.email).toBe('test@test.com'); // original unchanged
  });
});
