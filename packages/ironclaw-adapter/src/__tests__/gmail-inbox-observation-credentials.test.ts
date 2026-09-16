import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokenStoreConstructor = vi.fn();
const setKeyCache = vi.fn();
const setAuditLog = vi.fn();
const refreshIfExpiredWithRevision = vi.fn();

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

    refreshIfExpiredWithRevision(...args: unknown[]) {
      return refreshIfExpiredWithRevision(...args);
    }
  },
}));

vi.mock('@skytwin/db', () => ({
  gmailInboxObservationTargetRepository: { resolveInitial: vi.fn(), resolveFinal: vi.fn() },
  oauthRepository: { repository: 'oauth' },
}));

const { DbGmailInboxObservationCredentials } = await import(
  '../gmail-inbox-observation-port.js'
);
import type { DbGmailInboxObservationCredentialsOptions } from '../gmail-inbox-observation-port.js';

const request = {
  userId: '11111111-1111-4111-8111-111111111111',
  connectorAccountId: '44444444-44a4-4444-8444-444444444444',
  requiredScope: 'https://www.googleapis.com/auth/gmail.modify' as const,
};

describe('DbGmailInboxObservationCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshIfExpiredWithRevision.mockResolvedValue({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      expiresAt: new Date(Date.now() + 60_000),
      provider: 'google',
      credentialRevision: '55555555-5555-4555-8555-555555555555',
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
    expect(setKeyCache).toHaveBeenCalledWith(expect.objectContaining({
      get: expect.any(Function), has: expect.any(Function), set: expect.any(Function),
    }));
    expect(setAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      recordAccess: expect.any(Function),
    }), 'recovery_worker');
    expect(refreshIfExpiredWithRevision).toHaveBeenCalledWith(request.userId, 'google');
    expect(result).toEqual({
      accessToken: 'access-secret',
      credentialRevision: '55555555-5555-4555-8555-555555555555',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    });
    expect(Object.keys(result ?? {}).sort()).toEqual([
      'accessToken', 'credentialRevision', 'scopes',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.scopes)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('refresh-secret');
  });

  it('snapshots OAuth scalars and binds cache and audit methods at construction', async () => {
    const originalGet = vi.fn(() => null);
    const originalRecord = vi.fn();
    const googleOAuthConfig = {
      clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost',
    };
    const keyCache: NonNullable<DbGmailInboxObservationCredentialsOptions['keyCache']> = {
      get: originalGet, has: vi.fn(() => false), set: vi.fn(),
    };
    const auditLog: NonNullable<DbGmailInboxObservationCredentialsOptions['auditLog']> = {
      recordAccess: originalRecord,
    };
    const credentials = new DbGmailInboxObservationCredentials({
      googleOAuthConfig, keyCache, auditLog, auditActor: 'bound_actor',
    });
    googleOAuthConfig.clientId = 'swapped';
    keyCache.get = vi.fn(() => Buffer.alloc(32));
    auditLog.recordAccess = vi.fn();

    await credentials.materialize(request);

    expect(tokenStoreConstructor).toHaveBeenCalledWith(
      { repository: 'oauth' },
      { clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost' },
      undefined,
      request.connectorAccountId,
    );
    const boundCache = setKeyCache.mock.calls[0]?.[0] as typeof keyCache;
    const boundAudit = setAuditLog.mock.calls[0]?.[0] as typeof auditLog;
    boundCache.get(request.userId);
    boundAudit.recordAccess({
      userId: request.userId, actor: 'bound_actor', action: 'decrypt', resourceType: 'oauth',
    });
    expect(originalGet).toHaveBeenCalledTimes(1);
    expect(originalRecord).toHaveBeenCalledTimes(1);
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
    expect(refreshIfExpiredWithRevision).not.toHaveBeenCalled();
  });
});
