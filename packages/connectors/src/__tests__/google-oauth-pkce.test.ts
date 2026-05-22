import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateAuthUrl,
  generatePkcePair,
  exchangeCode,
  refreshAccessToken,
} from '../oauth/google-oauth.js';
import type { GoogleOAuthConfig } from '../oauth/google-oauth.js';
import { createHash } from 'node:crypto';

describe('google-oauth PKCE support', () => {
  describe('generatePkcePair', () => {
    it('returns a verifier in RFC 7636 length range (43..128 chars)', () => {
      const { codeVerifier } = generatePkcePair();
      expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(codeVerifier.length).toBeLessThanOrEqual(128);
    });

    it('produces a URL-safe base64 challenge that equals SHA-256(verifier)', () => {
      const { codeVerifier, codeChallenge } = generatePkcePair();
      const expected = createHash('sha256').update(codeVerifier).digest('base64url');
      expect(codeChallenge).toBe(expected);
    });

    it('yields a fresh verifier on every call (no stuck-randomness bug)', () => {
      const a = generatePkcePair();
      const b = generatePkcePair();
      expect(a.codeVerifier).not.toBe(b.codeVerifier);
    });
  });

  describe('generateAuthUrl', () => {
    const baseConfig: GoogleOAuthConfig = {
      clientId: 'public-client.apps.googleusercontent.com',
      clientSecret: '', // PKCE mode
      redirectUri: 'http://127.0.0.1:3100/api/oauth/google/callback',
    };

    it('omits code_challenge when none provided (confidential client flow)', () => {
      const url = generateAuthUrl(
        { ...baseConfig, clientSecret: 'real-secret' },
        ['openid'],
        'st',
      );
      expect(url).not.toContain('code_challenge');
      expect(url).not.toContain('code_challenge_method');
    });

    it('attaches S256 PKCE params when challenge is supplied', () => {
      const url = generateAuthUrl(baseConfig, ['openid'], 'st', 'cc-abc');
      expect(url).toContain('code_challenge=cc-abc');
      expect(url).toContain('code_challenge_method=S256');
    });

    it('passes the state through unchanged', () => {
      const url = generateAuthUrl(baseConfig, ['openid'], 'my-state', 'cc');
      expect(url).toContain('state=my-state');
    });
  });

  describe('exchangeCode', () => {
    const pkceConfig: GoogleOAuthConfig = {
      clientId: 'public.apps.googleusercontent.com',
      clientSecret: '',
      redirectUri: 'http://127.0.0.1:3100/api/oauth/google/callback',
    };
    const confidentialConfig: GoogleOAuthConfig = {
      clientId: 'confidential.apps.googleusercontent.com',
      clientSecret: 'kept-secret',
      redirectUri: 'http://localhost:3100/api/oauth/google/callback',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchSpy: any;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          scope: 'openid email',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    });
    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('PKCE mode sends code_verifier and no client_secret', async () => {
      await exchangeCode(pkceConfig, 'auth-code', 'verifier-xyz');
      const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as URLSearchParams;
      expect(body.get('code_verifier')).toBe('verifier-xyz');
      expect(body.get('client_secret')).toBeNull();
    });

    it('confidential mode sends client_secret and no code_verifier', async () => {
      await exchangeCode(confidentialConfig, 'auth-code');
      const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as URLSearchParams;
      expect(body.get('client_secret')).toBe('kept-secret');
      expect(body.get('code_verifier')).toBeNull();
    });

    it('throws when neither secret nor verifier is supplied', async () => {
      await expect(exchangeCode(pkceConfig, 'auth-code')).rejects.toThrow(/clientSecret.*codeVerifier/);
    });
  });

  describe('refreshAccessToken', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchSpy: any;
    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({ access_token: 'new-at', expires_in: 3600, scope: 'openid' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    });
    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('omits client_secret on refresh when the client is PKCE-only', async () => {
      await refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'refresh-token',
      );
      const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as URLSearchParams;
      expect(body.get('client_secret')).toBeNull();
      expect(body.get('refresh_token')).toBe('refresh-token');
    });

    it('includes client_secret on refresh for confidential clients', async () => {
      await refreshAccessToken(
        { clientId: 'conf.apps', clientSecret: 'keep', redirectUri: 'http://localhost/cb' },
        'refresh-token',
      );
      const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as URLSearchParams;
      expect(body.get('client_secret')).toBe('keep');
    });
  });
});
