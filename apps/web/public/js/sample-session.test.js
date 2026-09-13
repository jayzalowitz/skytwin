// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KEY_DEMO_SESSION_EXPIRES_AT,
  KEY_LEGACY_SAMPLE_DISABLED,
  KEY_SESSION_TOKEN,
  KEY_TOUR_MODE,
  KEY_USER_ID,
} from './storage-keys.js';
import {
  clearSampleSession,
  getEffectiveAuthToken,
  getEffectiveUserId,
  isSampleMode,
  migrateLegacySampleSession,
  SAMPLE_USER_ID,
  storeSampleSession,
} from './sample-session.js';

describe('tab-scoped sample session', () => {
  const realValues = new Map();
  const sampleValues = new Map();

  beforeEach(() => {
    realValues.clear();
    sampleValues.clear();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => realValues.get(key) ?? null),
      setItem: vi.fn((key, value) => realValues.set(key, String(value))),
      removeItem: vi.fn((key) => realValues.delete(key)),
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key) => sampleValues.get(key) ?? null),
      setItem: vi.fn((key, value) => sampleValues.set(key, String(value))),
      removeItem: vi.fn((key) => sampleValues.delete(key)),
    });
  });

  it('stores disposable authority without writing real authentication', () => {
    storeSampleSession({
      token: 'sample-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    expect(isSampleMode()).toBe(true);
    expect(getEffectiveAuthToken()).toBe('sample-token');
    expect(getEffectiveUserId()).toBe(SAMPLE_USER_ID);
    expect(realValues.size).toBe(0);
  });

  it('migrates the exact legacy sample shape without deleting shared keys', () => {
    const legacyToken = 'skytwin-demo-v1.1893456000000.nonce.signature';
    realValues.set(KEY_SESSION_TOKEN, legacyToken);
    realValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');
    realValues.set(KEY_TOUR_MODE, '1');
    realValues.set(KEY_USER_ID, SAMPLE_USER_ID);

    expect(migrateLegacySampleSession()).toBe(true);

    expect(isSampleMode()).toBe(true);
    expect(sampleValues.get(KEY_SESSION_TOKEN)).toBe(legacyToken);
    expect(realValues.get(KEY_SESSION_TOKEN)).toBe(legacyToken);
    expect(realValues.get(KEY_LEGACY_SAMPLE_DISABLED)).toBe('1');
  });

  it('makes a real login authoritative even if a sample tab still has state', () => {
    storeSampleSession({
      token: 'sample-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    realValues.set(KEY_SESSION_TOKEN, 'real-token');
    realValues.set(KEY_USER_ID, '11111111-2222-4333-8444-555555555555');

    expect(isSampleMode()).toBe(false);
    expect(getEffectiveAuthToken()).toBe('real-token');
    expect(getEffectiveUserId()).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('does not resurrect sample authority after a real login is retired', () => {
    storeSampleSession({
      token: 'sample-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    realValues.set(KEY_SESSION_TOKEN, 'real-token');
    realValues.set(KEY_USER_ID, '11111111-2222-4333-8444-555555555555');
    clearSampleSession();
    realValues.delete(KEY_SESSION_TOKEN);
    realValues.delete(KEY_USER_ID);

    expect(isSampleMode()).toBe(false);
    expect(getEffectiveAuthToken()).toBe('');
    expect(getEffectiveUserId()).toBe('');
  });

  it('cannot overwrite a login that lands during a sample storage transition', () => {
    sessionStorage.setItem.mockImplementation((key, value) => {
      sampleValues.set(key, String(value));
      if (key === KEY_SESSION_TOKEN) {
        realValues.set(KEY_SESSION_TOKEN, 'real-token');
        realValues.set(KEY_USER_ID, '11111111-2222-4333-8444-555555555555');
      }
    });

    expect(() => storeSampleSession({
      token: 'sample-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })).toThrow(/unavailable/i);
    expect(realValues.get(KEY_SESSION_TOKEN)).toBe('real-token');
    expect(realValues.get(KEY_USER_ID)).toBe('11111111-2222-4333-8444-555555555555');
    expect(sampleValues.has(KEY_SESSION_TOKEN)).toBe(false);
    expect(sampleValues.has(KEY_TOUR_MODE)).toBe(false);
  });

  it('clears only tab-local sample keys even if real auth changes mid-clear', () => {
    sampleValues.set(KEY_SESSION_TOKEN, 'sample-token');
    sampleValues.set(KEY_USER_ID, SAMPLE_USER_ID);
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');
    sessionStorage.removeItem.mockImplementation((key) => {
      sampleValues.delete(key);
      realValues.set(KEY_SESSION_TOKEN, 'real-token');
      realValues.set(KEY_USER_ID, '11111111-2222-4333-8444-555555555555');
    });

    clearSampleSession();

    expect(realValues.get(KEY_SESSION_TOKEN)).toBe('real-token');
    expect(realValues.get(KEY_USER_ID)).toBe('11111111-2222-4333-8444-555555555555');
    expect(sampleValues.has(KEY_SESSION_TOKEN)).toBe(false);
    expect(sampleValues.has(KEY_TOUR_MODE)).toBe(false);
  });
});
