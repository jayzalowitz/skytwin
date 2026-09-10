// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KEY_DEMO_SESSION_EXPIRES_AT,
  KEY_SESSION_TOKEN,
  KEY_TOUR_MODE,
  KEY_USER_ID,
} from './storage-keys.js';
import { fetchJSON, startDemoSession } from './api-client.js';

const source = readFileSync(new URL('./api-client.js', import.meta.url), 'utf8');

describe('api client', () => {
  const values = new Map();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
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

    expect(values.get(KEY_SESSION_TOKEN)).toBe('sample-token');
    expect(values.get(KEY_DEMO_SESSION_EXPIRES_AT)).toBe('2030-01-01T00:00:00.000Z');
  });

  it('renews an expired sample credential once and retries the read', async () => {
    values.set(KEY_TOUR_MODE, '1');
    values.set(KEY_SESSION_TOKEN, 'expired-token');
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

  it('rejects a sample credential for any other identity before storing it', async () => {
    values.set(KEY_TOUR_MODE, '1');
    values.set(KEY_SESSION_TOKEN, 'old-token');
    values.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
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
    expect(values.has(KEY_SESSION_TOKEN)).toBe(false);
    expect(values.has(KEY_TOUR_MODE)).toBe(false);
    expect(values.has(KEY_USER_ID)).toBe(false);
  });
});
