import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokenStoreConstructor = vi.fn();
const setKeyCache = vi.fn();
const setAuditLog = vi.fn();
const refreshIfExpired = vi.fn();

vi.mock('@skytwin/connectors', () => ({
  DbTokenStore: class {
    constructor(...args: unknown[]) {
      tokenStoreConstructor(...args);
    }

    setKeyCache(...args: unknown[]) {
      setKeyCache(...args);
    }

    setAuditLog(...args: unknown[]) {
      setAuditLog(...args);
    }

    refreshIfExpired(...args: unknown[]) {
      return refreshIfExpired(...args);
    }
  },
}));

vi.mock('@skytwin/db', () => ({
  gmailInboxObservationTargetRepository: { resolve: vi.fn() },
  oauthRepository: { repository: 'oauth' },
}));

const { DbGmailInboxObservationCredentials } = await import(
  '../gmail-inbox-observation-port.js'
);

const request = {
  userId: '11111111-1111-4111-8111-111111111111',
  connectorAccountId: '44444444-44a4-4444-8444-444444444444',
  requiredScope: 'https://www.googleapis.com/auth/gmail.modify' as const,
};

describe('DbGmailInboxObservationCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshIfExpired.mockResolvedValue({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      expiresAt: new Date(Date.now() + 60_000),
      provider: 'google',
    });
  });

  it('uses one account-bound Google token store and returns only frozen narrow credentials', async () => {
    const keyCache = { get: vi.fn(), has: vi.fn(), set: vi.fn() };
    const auditLog = { recordAccess: vi.fn() };
    const credentials = new DbGmailInboxObservationCredentials({
      googleOAuthConfig: {
        clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost',
      },
      keyCache,
      auditLog,
      auditActor: 'recovery_worker',
    });

    const result = await credentials.materialize(request);

    expect(tokenStoreConstructor).toHaveBeenCalledWith(
      { repository: 'oauth' },
      { clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost' },
      undefined,
      request.connectorAccountId,
    );
    expect(setKeyCache).toHaveBeenCalledWith(keyCache);
    expect(setAuditLog).toHaveBeenCalledWith(auditLog, 'recovery_worker');
    expect(refreshIfExpired).toHaveBeenCalledWith(request.userId, 'google');
    expect(result).toEqual({
      accessToken: 'access-secret',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    });
    expect(Object.keys(result ?? {}).sort()).toEqual(['accessToken', 'scopes']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.scopes)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('refresh-secret');
  });

  it.each([
    { ...request, extra: true },
    { ...request, userId: 'invalid' },
    { ...request, connectorAccountId: request.connectorAccountId.toUpperCase() },
    { ...request, requiredScope: 'https://www.googleapis.com/auth/gmail.readonly' },
  ])('rejects a non-canonical materialization request before touching secrets: %o', async (input) => {
    const credentials = new DbGmailInboxObservationCredentials({
      googleOAuthConfig: {
        clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost',
      },
    });

    await expect(credentials.materialize(input as typeof request)).rejects.toThrow(TypeError);
    expect(tokenStoreConstructor).not.toHaveBeenCalled();
    expect(refreshIfExpired).not.toHaveBeenCalled();
  });
});
