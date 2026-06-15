import { describe, it, expect } from 'vitest';
import {
  fetchGoogleProfileSync,
  type FetchLike,
} from '../google-profile-sync.js';

/**
 * Build a fetch stub that routes by URL substring to a fixed JSON body / status.
 * Throwing when no route matches keeps the tests honest about which endpoints
 * the sync actually calls.
 */
function makeFetch(
  routes: Record<string, { status?: number; body?: unknown; throw?: boolean }>,
): FetchLike {
  return async (input: string) => {
    for (const [pattern, route] of Object.entries(routes)) {
      if (input.includes(pattern)) {
        if (route.throw) throw new Error('network down');
        const status = route.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => route.body ?? {},
        };
      }
    }
    throw new Error(`Unrouted fetch: ${input}`);
  };
}

describe('fetchGoogleProfileSync (#486)', () => {
  it('captures a non-English locale and a non-UTC primary-calendar timezone (AC1)', async () => {
    const fetchImpl = makeFetch({
      '/userinfo': { body: { locale: 'ja', email: 'taro@example.com' } },
      '/calendars/primary': { body: { timeZone: 'Asia/Tokyo' } },
    });

    const result = await fetchGoogleProfileSync('access-token', fetchImpl);

    expect(result).toEqual({
      language: 'ja',
      timezone: 'Asia/Tokyo',
      languageDefaulted: false,
      timezoneDefaulted: false,
    });
  });

  it('passes the access token as a bearer header to both endpoints', async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, auth: init?.headers?.['Authorization'] });
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.includes('/userinfo') ? { locale: 'es' } : { timeZone: 'Europe/Madrid' },
      };
    };

    await fetchGoogleProfileSync('tok-123', fetchImpl);

    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.auth).toBe('Bearer tok-123');
    }
  });

  it('falls back to en + UTC (both flagged) when the profile has neither (AC6)', async () => {
    const fetchImpl = makeFetch({
      '/userinfo': { body: { email: 'noinfo@example.com' } }, // no locale
      '/calendars/primary': { body: {} }, // no timeZone
    });

    const result = await fetchGoogleProfileSync('access-token', fetchImpl);

    expect(result).toEqual({
      language: 'en',
      timezone: 'UTC',
      languageDefaulted: true,
      timezoneDefaulted: true,
    });
  });

  it('keeps the language when only the calendar read fails (independent reads)', async () => {
    const fetchImpl = makeFetch({
      '/userinfo': { body: { locale: 'fr' } },
      '/calendars/primary': { status: 403 }, // calendar scope not granted
    });

    const result = await fetchGoogleProfileSync('access-token', fetchImpl);

    expect(result.language).toBe('fr');
    expect(result.languageDefaulted).toBe(false);
    expect(result.timezone).toBe('UTC');
    expect(result.timezoneDefaulted).toBe(true);
  });

  it('never throws — a network error resolves to the defaulted result', async () => {
    const fetchImpl = makeFetch({
      '/userinfo': { throw: true },
      '/calendars/primary': { throw: true },
    });

    const result = await fetchGoogleProfileSync('access-token', fetchImpl);

    expect(result).toEqual({
      language: 'en',
      timezone: 'UTC',
      languageDefaulted: true,
      timezoneDefaulted: true,
    });
  });

  it('ignores non-string locale/timeZone shapes and falls back safely', async () => {
    const fetchImpl = makeFetch({
      '/userinfo': { body: { locale: 42 } },
      '/calendars/primary': { body: { timeZone: { nested: 'x' } } },
    });

    const result = await fetchGoogleProfileSync('access-token', fetchImpl);

    expect(result.language).toBe('en');
    expect(result.timezone).toBe('UTC');
    expect(result.languageDefaulted).toBe(true);
    expect(result.timezoneDefaulted).toBe(true);
  });
});
