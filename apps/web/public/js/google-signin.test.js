// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGoogleAuthUrl: vi.fn(),
  fetchOAuthStatus: vi.fn(),
  fetchPendingSignin: vi.fn(),
}));

vi.mock('./api-client.js', () => mocks);

import { derivePendingCapabilityDigest, startGoogleSignIn } from './google-signin.js';

function popup() {
  return {
    opener: { unsafe: true },
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
}

describe('Google new-user in-memory session handoff', () => {
  let authPopup;
  let localStorage;
  let sessionStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    authPopup = popup();
    localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    sessionStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('sessionStorage', sessionStorage);
    vi.stubGlobal('window', {
      skytwinDesktop: undefined,
      open: vi.fn(() => authPopup),
      location: { href: 'http://localhost/' },
    });
    mocks.getGoogleAuthUrl.mockResolvedValue({ url: 'https://accounts.example/authorize' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pre-opens an isolated browser popup before awaiting and polls with the closure-held capability', async () => {
    const completion = vi.fn();
    mocks.fetchPendingSignin.mockResolvedValue({
      connected: true,
      sessionToken: 'session-token',
      userId: 'user-1',
      accountEmail: 'person@example.com',
      scopes: ['openid'],
      nextHash: '#/connect-gmail',
    });

    const start = startGoogleSignIn({ newUser: true, next: 'connect-gmail', onComplete: completion });
    // Synchronous activation boundary: window.open happens before SHA-256 or
    // the authorize request has yielded back to the event loop.
    expect(window.open).toHaveBeenCalledOnce();
    expect(authPopup.opener).toBeNull();

    await expect(start).resolves.toEqual({ status: 'polling' });
    const options = mocks.getGoogleAuthUrl.mock.calls[0][1];
    expect(options.newUser).toBe(true);
    expect(options.pendingKeyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(authPopup.location.replace).toHaveBeenCalledWith('https://accounts.example/authorize');

    await vi.advanceTimersByTimeAsync(2_000);
    const rawCapability = mocks.fetchPendingSignin.mock.calls[0][0];
    expect(rawCapability).toMatch(/^[0-9a-f-]{36}$/i);
    expect(options.pendingKeyDigest).toBe(await derivePendingCapabilityDigest(rawCapability));
    expect(completion).toHaveBeenCalledWith(expect.objectContaining({
      connected: true, sessionToken: 'session-token', userId: 'user-1',
    }));
    expect(authPopup.close).toHaveBeenCalledOnce();
    expect(localStorage.setItem).not.toHaveBeenCalledWith(expect.anything(), rawCapability);
    expect(sessionStorage.setItem).not.toHaveBeenCalledWith(expect.anything(), rawCapability);
    expect(JSON.stringify([...localStorage.setItem.mock.calls, ...sessionStorage.setItem.mock.calls]))
      .not.toContain(rawCapability);
  });

  it('returns an actionable error without starting setup when the popup is blocked', async () => {
    window.open.mockReturnValue(null);
    await expect(startGoogleSignIn({ newUser: true, onComplete: vi.fn() })).resolves.toMatchObject({
      status: 'error',
      code: 'POPUP_BLOCKED',
      error: expect.stringMatching(/Allow pop-ups/i),
    });
    expect(mocks.getGoogleAuthUrl).not.toHaveBeenCalled();
    expect(mocks.fetchPendingSignin).not.toHaveBeenCalled();
  });

  it('closes the pre-opened popup when setup fails', async () => {
    mocks.getGoogleAuthUrl.mockRejectedValue(new Error('authorize unavailable'));
    await expect(startGoogleSignIn({ newUser: true, onComplete: vi.fn() })).resolves.toMatchObject({
      status: 'error',
    });
    expect(authPopup.close).toHaveBeenCalledOnce();
    expect(mocks.fetchPendingSignin).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('closes the pre-opened popup when pending sign-in times out', async () => {
    const completion = vi.fn();
    mocks.fetchPendingSignin.mockRejectedValue(new Error('not ready'));

    await expect(startGoogleSignIn({ newUser: true, onComplete: completion }))
      .resolves.toEqual({ status: 'polling' });
    await vi.advanceTimersByTimeAsync(300_000);

    expect(authPopup.close).toHaveBeenCalledOnce();
    expect(completion).toHaveBeenCalledOnce();
    expect(completion).toHaveBeenCalledWith({ connected: false });
  });

  it('keeps the desktop capability in memory and polls after opening the system browser', async () => {
    const completion = vi.fn();
    window.skytwinDesktop = { isDesktop: true, openExternal: vi.fn().mockResolvedValue(undefined) };
    mocks.fetchPendingSignin.mockResolvedValue({ connected: true, userId: 'user-1', sessionToken: 'token' });

    await expect(startGoogleSignIn({ newUser: true, onComplete: completion }))
      .resolves.toEqual({ status: 'polling' });
    expect(window.open).not.toHaveBeenCalled();
    expect(window.skytwinDesktop.openExternal).toHaveBeenCalledWith('https://accounts.example/authorize');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.fetchPendingSignin).toHaveBeenCalledOnce();
    expect(completion).toHaveBeenCalledWith(expect.objectContaining({ connected: true, userId: 'user-1' }));
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('preserves the existing-user browser full-page redirect', async () => {
    await expect(startGoogleSignIn({ userId: 'user-1' })).resolves.toEqual({ status: 'redirecting' });
    expect(window.open).not.toHaveBeenCalled();
    expect(window.location.href).toBe('https://accounts.example/authorize');
  });

  it('uses the server-compatible domain-separated digest', async () => {
    await expect(derivePendingCapabilityDigest('550e8400-e29b-41d4-a716-446655440000'))
      .resolves.toBe('a1e2b7f67d6cdd3b14fcb72990395bb7fc3bced3284fd7ea99eb7bfa3c68c087');
  });
});
