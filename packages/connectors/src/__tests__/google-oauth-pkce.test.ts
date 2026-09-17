import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateAuthUrl,
  generatePkcePair,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
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
        JSON.stringify({
          access_token: 'new-at', expires_in: 3600, scope: 'openid', token_type: 'Bearer',
        }),
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

    it('uses one fixed-origin request with redirect rejection and an owned timeout signal', async () => {
      await refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'refresh-token',
      );

      expect(fetchSpy).toHaveBeenCalledWith('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: expect.any(URLSearchParams),
        redirect: 'error',
        signal: expect.any(AbortSignal),
      });
    });

    it('retains only a bounded sanitized provider error code', async () => {
      const response = new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'secret provider detail must not flow',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const refreshFetch = vi.fn().mockResolvedValue(response);

      const error = await refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'refresh-token',
        { fetch: refreshFetch },
      ).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ errorCode: 'invalid_grant', permanent: true });
      expect((error as Error).message).toContain('{"error":"invalid_grant"}');
      expect((error as Error).message).not.toContain('secret provider detail');
    });

    it('cancels an invalid error body and exposes no provider detail', async () => {
      const response = new Response('secret provider detail', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
      const cancel = vi.spyOn(response.body!, 'cancel');
      const error = await refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'refresh-token',
        { fetch: vi.fn().mockResolvedValue(response) },
      ).catch((cause: unknown) => cause);

      expect(error).toMatchObject({ errorCode: null, permanent: true });
      expect((error as Error).message).not.toContain('secret provider detail');
      expect(cancel).toHaveBeenCalledOnce();
    });

    it.each([
      ['missing content type', new Response(JSON.stringify({
        access_token: 'new-at', expires_in: 3600, scope: 'openid', token_type: 'Bearer',
      }), { status: 200 })],
      ['wrong content type', new Response(JSON.stringify({
        access_token: 'new-at', expires_in: 3600, scope: 'openid', token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'text/plain' } })],
      ['missing field', new Response(JSON.stringify({
        access_token: 'new-at', expires_in: 3600, token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
      ['missing token type', new Response(JSON.stringify({
        access_token: 'new-at', expires_in: 3600, scope: 'openid',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
      ['wrong token type', new Response(JSON.stringify({
        access_token: 'new-at', expires_in: 3600, scope: 'openid', token_type: 'MAC',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
      ['wrong field type', new Response(JSON.stringify({
        access_token: 'new-at', expires_in: '3600', scope: 'openid', token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
      ['invalid UTF-8', new Response(new Uint8Array([0xc3, 0x28]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })],
      ['oversized body', new Response('x'.repeat(16 * 1024 + 1), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })],
    ])('rejects a bounded refresh response with %s', async (_name, response) => {
      await expect(refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'refresh-token',
        { fetch: vi.fn().mockResolvedValue(response) },
      )).rejects.toThrow(/invalid provider response/);
    });

    it('ignores bounded unconsumed response fields without persisting returned secrets', async () => {
      const result = await refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'stored-refresh-token',
        { fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
          access_token: 'new-at',
          expires_in: 3600,
          scope: 'openid email',
          token_type: 'Bearer',
          refresh_token: 'provider-rotated-secret',
          refresh_token_expires_in: 604800,
          id_token: 'unconsumed-id-secret',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })) },
      );

      expect(result).toMatchObject({
        accessToken: 'new-at',
        refreshToken: 'stored-refresh-token',
        scopes: ['openid', 'email'],
        provider: 'google',
      });
      expect(JSON.stringify(result)).not.toContain('provider-rotated-secret');
      expect(JSON.stringify(result)).not.toContain('unconsumed-id-secret');
    });

    it('accepts bearer token type case-insensitively', async () => {
      const result = await refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'stored-refresh-token',
        { fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
          access_token: 'new-at',
          expires_in: 3600,
          scope: 'openid email',
          token_type: 'bearer',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })) },
      );

      expect(result.scopes).toEqual(['openid', 'email']);
    });

    it('preserves the validated persisted grant when the provider omits scope', async () => {
      const persistedScopes = ['openid', 'https://www.googleapis.com/auth/gmail.modify'];
      const result = await refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'stored-refresh-token',
        {
          persistedScopes,
          fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
            access_token: 'new-at',
            expires_in: 3600,
            token_type: 'Bearer',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
        },
      );

      expect(result.scopes).toEqual(persistedScopes);
      expect(result.scopes).not.toBe(persistedScopes);
    });

    it.each([
      ['absent', undefined],
      ['empty', []],
      ['empty entry', ['']],
      ['duplicate', ['openid', 'openid']],
      ['oversized entry', ['x'.repeat(513)]],
    ])('rejects omitted provider scope with %s persisted scopes', async (_name, persistedScopes) => {
      await expect(refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'stored-refresh-token',
        {
          persistedScopes,
          fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
            access_token: 'new-at',
            expires_in: 3600,
            token_type: 'Bearer',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
        },
      )).rejects.toThrow(/invalid provider response/);
    });

    it('rejects an explicit empty provider scope instead of inheriting persisted scopes', async () => {
      await expect(refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'stored-refresh-token',
        {
          persistedScopes: ['openid'],
          fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
            access_token: 'new-at',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
        },
      )).rejects.toThrow(/invalid provider response/);
    });

    it.each(['not-a-number', '-1', String(16 * 1024 + 1)])(
      'rejects declared refresh body length %s before parsing',
      async (contentLength) => {
        const response = new Response(JSON.stringify({
          access_token: 'new-at', expires_in: 3600, scope: 'openid', token_type: 'Bearer',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Length': contentLength },
        });
        const cancel = vi.spyOn(response.body!, 'cancel');
        await expect(refreshAccessToken(
          { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
          'refresh-token',
          { fetch: vi.fn().mockResolvedValue(response) },
        )).rejects.toThrow(/invalid provider response/);
        expect(cancel).toHaveBeenCalledOnce();
      },
    );

    it('keeps its timeout active while the refresh response body is streaming', async () => {
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      });
      const refreshFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener('abort', () => {
          streamController?.error(new DOMException('aborted', 'AbortError'));
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      await expect(refreshAccessToken(
        { clientId: 'public.apps', clientSecret: '', redirectUri: 'http://127.0.0.1/cb' },
        'refresh-token',
        { fetch: refreshFetch, timeoutMs: 10 },
      )).rejects.toThrow(/transport unavailable/);
      expect((refreshFetch.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    });
  });

  describe('revokeToken', () => {
    afterEach(() => vi.restoreAllMocks());

    it('treats Google invalid_token as converged revocation for crash recovery', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({ error: 'invalid_token' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ));
      await expect(revokeToken('already-revoked')).resolves.toBeUndefined();
    });

    it('does not claim revocation for an arbitrary provider failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }));
      await expect(revokeToken('still-unknown')).rejects.toThrow('revocation failed: 503');
    });
  });
});
