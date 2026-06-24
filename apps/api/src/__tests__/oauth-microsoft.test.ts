import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchMicrosoftUserInfo,
  resolveMicrosoftEnvConfig,
  providerSupportsRevoke,
} from '../routes/oauth.js';

/**
 * Unit tests for the Microsoft (Entra / Outlook) OAuth helpers — the pure,
 * testable core of the connect flow (matching the existing oauth test
 * philosophy of testing exported helpers, not full route round-trips). The
 * OAuth protocol functions themselves are tested in @skytwin/connectors.
 */

describe('resolveMicrosoftEnvConfig', () => {
  it('uses operator-supplied MICROSOFT_CLIENT_ID/_SECRET (user-supplied source)', () => {
    const cfg = resolveMicrosoftEnvConfig({
      MICROSOFT_CLIENT_ID: 'op-client',
      MICROSOFT_CLIENT_SECRET: 'op-secret',
      MICROSOFT_REDIRECT_URI: 'https://app/cb',
      MICROSOFT_TENANT: 'contoso',
    } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({
      clientId: 'op-client',
      clientSecret: 'op-secret',
      redirectUri: 'https://app/cb',
      tenant: 'contoso',
      source: 'user-supplied',
    });
  });

  it('falls back to the bundled default with an empty secret (PKCE/public-client)', () => {
    const cfg = resolveMicrosoftEnvConfig({
      SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID: 'bundled-client',
    } as NodeJS.ProcessEnv);
    expect(cfg.clientId).toBe('bundled-client');
    expect(cfg.clientSecret).toBe(''); // load-bearing: selects PKCE token exchange
    expect(cfg.source).toBe('bundled');
    expect(cfg.tenant).toBe('common'); // default tenant
  });

  it('is "unset" with a default redirect when nothing is configured', () => {
    const cfg = resolveMicrosoftEnvConfig({} as NodeJS.ProcessEnv);
    expect(cfg.clientId).toBe('');
    expect(cfg.source).toBe('unset');
    expect(cfg.redirectUri).toBe('http://localhost:3100/api/oauth/microsoft/callback');
  });

  it('prefers an operator client over the bundled default', () => {
    const cfg = resolveMicrosoftEnvConfig({
      MICROSOFT_CLIENT_ID: 'op',
      SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID: 'bundled',
    } as NodeJS.ProcessEnv);
    expect(cfg.clientId).toBe('op');
    expect(cfg.source).toBe('user-supplied');
  });
});

describe('providerSupportsRevoke (token-leak guard for disconnect)', () => {
  it('is true only for Google — the only provider with a revoke endpoint', () => {
    expect(providerSupportsRevoke('google')).toBe(true);
  });

  it('is false for Microsoft — revoking there would POST the MS token to Google', () => {
    expect(providerSupportsRevoke('microsoft')).toBe(false);
  });

  it('is false for any unknown provider (fail safe — never revoke blindly)', () => {
    expect(providerSupportsRevoke('slack')).toBe(false);
    expect(providerSupportsRevoke('')).toBe(false);
  });
});

describe('fetchMicrosoftUserInfo', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('queries Graph /me with the bearer token and prefers `mail`', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'oid-1', mail: 'work@contoso.com', userPrincipalName: 'work@contoso.onmicrosoft.com', displayName: 'Work User' }),
    });
    const info = await fetchMicrosoftUserInfo('access-token');

    const [url, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me');
    expect(opts.headers.Authorization).toBe('Bearer access-token');
    expect(info).toEqual({ id: 'oid-1', email: 'work@contoso.com', name: 'Work User' });
  });

  it('falls back to userPrincipalName when mail is null (personal Outlook.com accounts)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'oid-2', mail: null, userPrincipalName: 'me@outlook.com', displayName: 'Me' }),
    });
    const info = await fetchMicrosoftUserInfo('t');
    expect(info.email).toBe('me@outlook.com');
  });

  it('returns an empty email when neither mail nor userPrincipalName is present (caller 502s)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'oid-3' }) });
    const info = await fetchMicrosoftUserInfo('t');
    expect(info.email).toBe('');
  });

  it('throws on a non-OK Graph response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    await expect(fetchMicrosoftUserInfo('t')).rejects.toThrow(/Graph \/me failed: 401/);
  });
});
