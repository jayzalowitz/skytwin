import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateAuthUrl,
  generatePkcePair,
  exchangeCode,
  refreshAccessToken,
  MicrosoftOAuthRefreshError,
  MICROSOFT_GRAPH_SCOPES,
} from '../oauth/microsoft-oauth.js';
import type { MicrosoftOAuthConfig } from '../oauth/microsoft-oauth.js';

const baseConfig: MicrosoftOAuthConfig = {
  clientId: 'app-client-id',
  clientSecret: '', // PKCE/public-client mode
  redirectUri: 'http://127.0.0.1:3100/api/oauth/microsoft/callback',
};

describe('microsoft-oauth', () => {
  describe('generateAuthUrl', () => {
    it('targets the common-tenant v2 authorize endpoint by default', () => {
      const url = generateAuthUrl(baseConfig, [MICROSOFT_GRAPH_SCOPES.mailRead], 'st');
      expect(url.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?')).toBe(true);
      expect(url).toContain('client_id=app-client-id');
      expect(url).toContain('response_type=code');
      expect(url).toContain('response_mode=query');
    });

    it('honors a specific tenant', () => {
      const url = generateAuthUrl({ ...baseConfig, tenant: 'contoso.onmicrosoft.com' }, ['User.Read']);
      expect(url).toContain('/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
    });

    it('force-adds offline_access so the grant yields a refresh token', () => {
      const url = generateAuthUrl(baseConfig, ['Mail.Read']);
      const scope = decodeURIComponent(new URL(url).searchParams.get('scope') ?? '');
      expect(scope.split(' ')).toContain('offline_access');
      expect(scope.split(' ')).toContain('Mail.Read');
    });

    it('does not duplicate offline_access when already requested', () => {
      const url = generateAuthUrl(baseConfig, ['Mail.Read', 'offline_access']);
      const scope = decodeURIComponent(new URL(url).searchParams.get('scope') ?? '');
      expect(scope.split(' ').filter((s) => s === 'offline_access')).toHaveLength(1);
    });

    it('attaches S256 PKCE params only when a challenge is supplied', () => {
      expect(generateAuthUrl(baseConfig, ['User.Read'], 'st')).not.toContain('code_challenge');
      const withPkce = generateAuthUrl(baseConfig, ['User.Read'], 'st', 'cc-xyz');
      expect(withPkce).toContain('code_challenge=cc-xyz');
      expect(withPkce).toContain('code_challenge_method=S256');
    });

    it('passes state through', () => {
      const url = generateAuthUrl(baseConfig, ['User.Read'], 'signed-state-123');
      expect(new URL(url).searchParams.get('state')).toBe('signed-state-123');
    });
  });

  describe('generatePkcePair (reused, provider-agnostic)', () => {
    it('yields an RFC-7636-length verifier', () => {
      const { codeVerifier } = generatePkcePair();
      expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(codeVerifier.length).toBeLessThanOrEqual(128);
    });
  });

  describe('exchangeCode', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    function okToken(extra: Record<string, unknown> = {}) {
      return {
        ok: true,
        json: async () => ({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3600,
          scope: 'Mail.Read Calendars.Read offline_access',
          ...extra,
        }),
      };
    }

    it('posts to the token endpoint with code_verifier in PKCE mode and parses an OAuthTokenSet', async () => {
      fetchMock.mockResolvedValue(okToken());
      const result = await exchangeCode(baseConfig, 'auth-code', 'verifier-abc');

      const [url, opts] = fetchMock.mock.calls[0] as [string, { body: URLSearchParams }];
      expect(url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
      const body = opts.body;
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('code_verifier')).toBe('verifier-abc');
      expect(body.get('client_secret')).toBeNull();

      expect(result.provider).toBe('microsoft');
      expect(result.accessToken).toBe('at-1');
      expect(result.refreshToken).toBe('rt-1');
      expect(result.scopes).toEqual(['Mail.Read', 'Calendars.Read', 'offline_access']);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('sends client_secret (not code_verifier) in confidential mode', async () => {
      fetchMock.mockResolvedValue(okToken());
      await exchangeCode({ ...baseConfig, clientSecret: 'sshh' }, 'auth-code', 'verifier-abc');
      const [, opts] = fetchMock.mock.calls[0] as [string, { body: URLSearchParams }];
      expect(opts.body.get('client_secret')).toBe('sshh');
      expect(opts.body.get('code_verifier')).toBeNull();
    });

    it('includes redirect_uri on the exchange (Microsoft requires it to match the authorize leg)', async () => {
      fetchMock.mockResolvedValue(okToken());
      await exchangeCode(baseConfig, 'auth-code', 'v');
      const [, opts] = fetchMock.mock.calls[0] as [string, { body: URLSearchParams }];
      expect(opts.body.get('redirect_uri')).toBe(baseConfig.redirectUri);
    });

    it('throws when the token response has no refresh_token (misconfigured app)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'at', expires_in: 3600, scope: 'Mail.Read' }),
      });
      await expect(exchangeCode(baseConfig, 'c', 'v')).rejects.toThrow(/no refresh_token/);
    });

    it('treats a missing expires_in as already-expired (no Invalid Date)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'at', refresh_token: 'rt', scope: 'Mail.Read' }),
      });
      const result = await exchangeCode(baseConfig, 'c', 'v');
      expect(Number.isNaN(result.expiresAt.getTime())).toBe(false);
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('throws when neither clientSecret nor codeVerifier is available', async () => {
      await expect(exchangeCode(baseConfig, 'auth-code')).rejects.toThrow(/clientSecret.*codeVerifier/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws on a non-OK token response', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' });
      await expect(exchangeCode(baseConfig, 'bad', 'v')).rejects.toThrow(/token exchange failed: 400/);
    });
  });

  describe('refreshAccessToken', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('keeps the stored refresh token when Microsoft omits one (no rotation)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'at-2', expires_in: 3600, scope: 'Mail.Read' }),
      });
      const result = await refreshAccessToken({ ...baseConfig, clientSecret: 'sshh' }, 'stored-rt');
      const [, opts] = fetchMock.mock.calls[0] as [string, { body: URLSearchParams }];
      expect(opts.body.get('grant_type')).toBe('refresh_token');
      expect(result.refreshToken).toBe('stored-rt');
      expect(result.provider).toBe('microsoft');
    });

    it('omits client_secret on refresh in PKCE/public-client mode', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'at', expires_in: 3600, scope: '' }),
      });
      await refreshAccessToken(baseConfig, 'stored-rt'); // baseConfig.clientSecret === ''
      const [, opts] = fetchMock.mock.calls[0] as [string, { body: URLSearchParams }];
      expect(opts.body.get('client_secret')).toBeNull();
    });

    it('adopts a rotated refresh token when the response returns one', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'at-3', refresh_token: 'rotated-rt', expires_in: 3600, scope: '' }),
      });
      const result = await refreshAccessToken(baseConfig, 'stored-rt');
      expect(result.refreshToken).toBe('rotated-rt');
      expect(result.scopes).toEqual([]);
    });

    it('classifies a 401 as permanent (re-auth required)', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'invalid_grant' });
      const err = await refreshAccessToken(baseConfig, 'rt').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MicrosoftOAuthRefreshError);
      expect((err as MicrosoftOAuthRefreshError).permanent).toBe(true);
    });

    it('classifies a 503 as transient (retry-worthy)', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'try later' });
      const err = await refreshAccessToken(baseConfig, 'rt').catch((e: unknown) => e);
      expect((err as MicrosoftOAuthRefreshError).permanent).toBe(false);
    });
  });
});
