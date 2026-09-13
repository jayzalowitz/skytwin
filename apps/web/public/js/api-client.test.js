// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KEY_DEMO_SESSION_EXPIRES_AT,
  KEY_SESSION_TOKEN,
  KEY_TOUR_MODE,
  KEY_USER_ID,
} from './storage-keys.js';
import {
  endSampleSimulation,
  fetchJSON,
  sendSampleSimulationCommand,
  startDemoSession,
} from './api-client.js';

const source = readFileSync(new URL('./api-client.js', import.meta.url), 'utf8');

describe('api client', () => {
  const values = new Map();
  const sampleValues = new Map();

  beforeEach(() => {
    values.clear();
    sampleValues.clear();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key) => sampleValues.get(key) ?? null),
      setItem: vi.fn((key, value) => sampleValues.set(key, String(value))),
      removeItem: vi.fn((key) => sampleValues.delete(key)),
    });
    vi.restoreAllMocks();
  });

  it('treats 204 No Content as a successful empty response', () => {
    expect(source).toContain('if (res.status === 204) return null;');
  });

  it('stores the credential and expiry when a sample session starts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            token: 'sample-token',
            userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            expiresAt: '2030-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await startDemoSession();

    expect(sampleValues.get(KEY_SESSION_TOKEN)).toBe('sample-token');
    expect(sampleValues.get(KEY_DEMO_SESSION_EXPIRES_AT)).toBe('2030-01-01T00:00:00.000Z');
    expect(values.has(KEY_SESSION_TOKEN)).toBe(false);
  });

  it('renews an expired sample credential once and retries the read', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'expired-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'renewed-token',
            userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            expiresAt: '2030-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'sample-user' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchJSON('/api/users/sample-user')).resolves.toEqual({ id: 'sample-user' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer renewed-token');
  });

  it('reuses one successor when parallel reads receive staggered 401s', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'old-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');

    let releaseFirstRequest;
    const firstRequest = new Promise((resolve) => {
      releaseFirstRequest = resolve;
    });
    let sessionRequests = 0;
    const fetchMock = vi.fn(async (url, options) => {
      if (url === '/api/v1/demo/session') {
        sessionRequests += 1;
        return new Response(JSON.stringify({
          token: `renewed-token-${sessionRequests}`,
          userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          expiresAt: '2030-01-01T00:00:00.000Z',
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (options.headers.Authorization === 'Bearer old-token') {
        if (url === '/api/users/first') return firstRequest;
        return new Response('{}', { status: 401 });
      }
      return new Response(JSON.stringify({ id: url }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchJSON('/api/users/first');
    const second = fetchJSON('/api/users/second');
    await vi.waitFor(() => expect(sessionRequests).toBe(1));
    await expect(second).resolves.toEqual({ id: '/api/users/second' });

    releaseFirstRequest(new Response('{}', { status: 401 }));
    await expect(first).resolves.toEqual({ id: '/api/users/first' });

    expect(sessionRequests).toBe(1);
    const renewedReads = fetchMock.mock.calls.filter(
      ([url, options]) =>
        url !== '/api/v1/demo/session' &&
        options.headers.Authorization === 'Bearer renewed-token-1',
    );
    expect(renewedReads).toHaveLength(2);
  });

  it('joins one renewal when parallel sample reads fail together', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'old-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');

    let releaseRenewal;
    const renewal = new Promise((resolve) => {
      releaseRenewal = resolve;
    });
    let sessionRequests = 0;
    const fetchMock = vi.fn((url, options) => {
      if (url === '/api/v1/demo/session') {
        sessionRequests += 1;
        return renewal;
      }
      if (options.headers.Authorization === 'Bearer old-token') {
        return Promise.resolve(new Response('{}', { status: 401 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: url }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const reads = [
      fetchJSON('/api/users/first'),
      fetchJSON('/api/users/second'),
    ];
    await vi.waitFor(() => expect(sessionRequests).toBe(1));
    releaseRenewal(new Response(JSON.stringify({
      token: 'renewed-token',
      userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(Promise.all(reads)).resolves.toEqual([
      { id: '/api/users/first' },
      { id: '/api/users/second' },
    ]);
    expect(sessionRequests).toBe(1);
  });

  it('does not renew a request that was sent before sample authority existed', async () => {
    let releaseRequest;
    const request = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchJSON('/api/users/anonymous');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'new-sample-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');
    releaseRequest(new Response('{}', { status: 401 }));

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not renew an old sample request after real authentication wins', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'old-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');
    let releaseRequest;
    const request = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchJSON('/api/users/sample');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    values.set(KEY_SESSION_TOKEN, 'real-token');
    values.set(KEY_USER_ID, '11111111-1111-4111-8111-111111111111');
    releaseRequest(new Response('{}', { status: 401 }));

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(values.get(KEY_SESSION_TOKEN)).toBe('real-token');
  });

  it('never replaces a real session when a stale sample marker survives', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'stale-sample-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2020-01-01T00:00:00.000Z');
    values.set(KEY_USER_ID, '11111111-1111-4111-8111-111111111111');
    values.set(KEY_SESSION_TOKEN, 'real-token');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchJSON('/api/users/real-user')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(values.get(KEY_SESSION_TOKEN)).toBe('real-token');
  });

  it('keeps authentication when a caller supplies additional headers', async () => {
    values.set(KEY_SESSION_TOKEN, 'real-token');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchJSON('/api/protected', {
      headers: { 'X-Request-Mode': 'test' },
    });

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer real-token',
      'Content-Type': 'application/json',
      'X-Request-Mode': 'test',
    });
  });

  it('deletes disposable state with the original token without renewal', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'expired-sample-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2020-01-01T00:00:00.000Z');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(endSampleSimulation()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'DELETE',
      headers: { Authorization: 'Bearer expired-sample-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('does not replay a command into a replacement session after expiry', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'expired-sample-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2020-01-01T00:00:00.000Z');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Sample session expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendSampleSimulationCommand({
        type: 'approve',
        proposalId: 'calendar-focus',
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer expired-sample-token',
    );
    expect(sampleValues.get(KEY_SESSION_TOKEN)).toBe('expired-sample-token');
  });

  it('rejects a sample credential for any other identity before storing it', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_SESSION_TOKEN, 'old-token');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            token: 'wrong-token',
            userId: '00000000-0000-4000-8000-000000000000',
            expiresAt: '2030-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(startDemoSession()).rejects.toThrow(/invalid/i);
    expect(sampleValues.has(KEY_SESSION_TOKEN)).toBe(false);
    expect(sampleValues.has(KEY_TOUR_MODE)).toBe(false);
    expect(sampleValues.has(KEY_USER_ID)).toBe(false);
  });

  for (const responseKind of ['valid', 'invalid']) {
    it(`preserves a real session established during an in-flight ${responseKind} sample response`, async () => {
      let resolveFetch;
      const pendingResponse = new Promise((resolve) => {
        resolveFetch = resolve;
      });
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingResponse));

      const starting = startDemoSession();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      values.set(KEY_USER_ID, '11111111-1111-4111-8111-111111111111');
      values.set(KEY_SESSION_TOKEN, 'real-token');

      resolveFetch(new Response(JSON.stringify(responseKind === 'valid' ? {
        token: 'late-sample-token',
        userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        expiresAt: '2030-01-01T00:00:00.000Z',
      } : { token: '', userId: 'wrong' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));

      await expect(starting).rejects.toThrow(/authentication changed/i);
      expect(values.get(KEY_USER_ID)).toBe('11111111-1111-4111-8111-111111111111');
      expect(values.get(KEY_SESSION_TOKEN)).toBe('real-token');
      expect(sampleValues.has(KEY_SESSION_TOKEN)).toBe(false);
      expect(sampleValues.has(KEY_TOUR_MODE)).toBe(false);
      expect(sampleValues.has(KEY_DEMO_SESSION_EXPIRES_AT)).toBe(false);
    });
  }
});
