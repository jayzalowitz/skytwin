import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DbTokenStore } from '../oauth/db-token-store.js';

// Mock BOTH provider refresh modules so we can assert which endpoint a
// refresh actually hits (the security-relevant behavior: a microsoft token
// must NEVER be refreshed through Google's endpoint).
vi.mock('../oauth/google-oauth.js', () => ({ refreshAccessToken: vi.fn() }));
vi.mock('../oauth/microsoft-oauth.js', () => ({ refreshAccessToken: vi.fn() }));

import { refreshAccessToken as googleRefresh } from '../oauth/google-oauth.js';
import { refreshAccessToken as microsoftRefresh } from '../oauth/microsoft-oauth.js';

const mockGoogleRefresh = vi.mocked(googleRefresh);
const mockMicrosoftRefresh = vi.mocked(microsoftRefresh);

function createMockRepo() {
  return {
    getToken: vi.fn(),
    saveToken: vi.fn(),
    deleteToken: vi.fn(),
    updateAccessToken: vi.fn(),
  };
}

const googleConfig = { clientId: 'g', clientSecret: 'gs', redirectUri: 'http://localhost/cb' };
const microsoftConfig = { clientId: 'm', clientSecret: 'ms', redirectUri: 'http://localhost/ms', tenant: 'common' };

function expiredRow() {
  return { access_token: 'old-at', refresh_token: 'rt', expires_at: new Date(Date.now() - 60_000), scopes: ['s'] };
}
function freshSet(provider: 'google' | 'microsoft', accessToken: string) {
  return { accessToken, refreshToken: 'rt', expiresAt: new Date(Date.now() + 3_600_000), scopes: ['s'], provider };
}

describe('DbTokenStore provider-aware refresh', () => {
  let repo: ReturnType<typeof createMockRepo>;
  beforeEach(() => {
    vi.clearAllMocks();
    repo = createMockRepo();
  });

  it('refreshes a google token via the Google endpoint only', async () => {
    repo.getToken.mockResolvedValue(expiredRow());
    mockGoogleRefresh.mockResolvedValue(freshSet('google', 'new-google-at'));
    const store = new DbTokenStore(repo, googleConfig, microsoftConfig);

    const out = await store.refreshIfExpired('u1', 'google');
    expect(mockGoogleRefresh).toHaveBeenCalledTimes(1);
    expect(mockMicrosoftRefresh).not.toHaveBeenCalled();
    expect(out.accessToken).toBe('new-google-at');
  });

  it('refreshes a microsoft token via the Microsoft endpoint when configured', async () => {
    repo.getToken.mockResolvedValue(expiredRow());
    mockMicrosoftRefresh.mockResolvedValue(freshSet('microsoft', 'new-ms-at'));
    const store = new DbTokenStore(repo, googleConfig, microsoftConfig);

    const out = await store.refreshIfExpired('u1', 'microsoft');
    expect(mockMicrosoftRefresh).toHaveBeenCalledTimes(1);
    expect(mockGoogleRefresh).not.toHaveBeenCalled();
    expect(out.accessToken).toBe('new-ms-at');
  });

  it('REFUSES to refresh a microsoft token when no microsoftConfig is wired (never leaks to Google)', async () => {
    repo.getToken.mockResolvedValue(expiredRow());
    const store = new DbTokenStore(repo, googleConfig); // no microsoftConfig

    await expect(store.refreshIfExpired('u1', 'microsoft')).rejects.toThrow(/refusing to refresh a microsoft token/);
    // The whole point: it must NOT have fallen back to the Google endpoint.
    expect(mockGoogleRefresh).not.toHaveBeenCalled();
    expect(mockMicrosoftRefresh).not.toHaveBeenCalled();
  });

  it('refuses to refresh a google token when no googleConfig is wired (Microsoft-only deployment)', async () => {
    repo.getToken.mockResolvedValue(expiredRow());
    const store = new DbTokenStore(repo, undefined, microsoftConfig); // no googleConfig
    await expect(store.refreshIfExpired('u1', 'google')).rejects.toThrow(/refusing to refresh a google token/);
    expect(mockGoogleRefresh).not.toHaveBeenCalled();
  });

  it('throws on an unsupported provider BEFORE touching the token store', async () => {
    repo.getToken.mockResolvedValue(expiredRow());
    const store = new DbTokenStore(repo, googleConfig, microsoftConfig);
    await expect(store.refreshIfExpired('u1', 'slack')).rejects.toThrow(/unsupported provider 'slack'/);
    // Fails up-front — no token fetch/decrypt, no refresh call.
    expect(repo.getToken).not.toHaveBeenCalled();
    expect(mockGoogleRefresh).not.toHaveBeenCalled();
    expect(mockMicrosoftRefresh).not.toHaveBeenCalled();
  });

  it('does not refresh a still-valid token (no endpoint call for either provider)', async () => {
    repo.getToken.mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_at: new Date(Date.now() + 3_600_000), scopes: ['s'] });
    const store = new DbTokenStore(repo, googleConfig, microsoftConfig);
    const out = await store.refreshIfExpired('u1', 'microsoft');
    expect(mockMicrosoftRefresh).not.toHaveBeenCalled();
    expect(mockGoogleRefresh).not.toHaveBeenCalled();
    expect(out.accessToken).toBe('at');
  });
});
