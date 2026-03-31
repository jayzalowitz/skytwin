import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DbTokenStore } from '../oauth/db-token-store.js';

// Mock the google-oauth refresh function
vi.mock('../oauth/google-oauth.js', () => ({
  refreshAccessToken: vi.fn(),
}));

import { refreshAccessToken } from '../oauth/google-oauth.js';

const mockRefresh = vi.mocked(refreshAccessToken);

function createMockRepo() {
  return {
    getToken: vi.fn(),
    saveToken: vi.fn(),
    deleteToken: vi.fn(),
    updateAccessToken: vi.fn(),
  };
}

const oauthConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:3100/callback',
};

describe('DbTokenStore', () => {
  let repo: ReturnType<typeof createMockRepo>;
  let store: DbTokenStore;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = createMockRepo();
    store = new DbTokenStore(repo, oauthConfig);
  });

  it('getToken returns null when no token exists', async () => {
    repo.getToken.mockResolvedValue(null);
    const result = await store.getToken('user1', 'google');
    expect(result).toBeNull();
    expect(repo.getToken).toHaveBeenCalledWith('user1', 'google');
  });

  it('getToken maps DB row to OAuthTokenSet', async () => {
    const expiresAt = new Date('2026-04-01T00:00:00Z');
    repo.getToken.mockResolvedValue({
      access_token: 'access-123',
      refresh_token: 'refresh-456',
      expires_at: expiresAt,
      scopes: ['email', 'calendar'],
    });

    const result = await store.getToken('user1', 'google');
    expect(result).toEqual({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt,
      scopes: ['email', 'calendar'],
      provider: 'google',
    });
  });

  it('saveToken delegates to repo with correct args', async () => {
    repo.saveToken.mockResolvedValue({});
    const expiresAt = new Date('2026-04-01T00:00:00Z');

    await store.saveToken('user1', 'google', {
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt,
      scopes: ['email'],
      provider: 'google',
    });

    expect(repo.saveToken).toHaveBeenCalledWith(
      'user1', 'google', 'access-123', 'refresh-456', expiresAt, ['email'],
    );
  });

  it('deleteToken delegates to repo', async () => {
    repo.deleteToken.mockResolvedValue(true);
    await store.deleteToken('user1', 'google');
    expect(repo.deleteToken).toHaveBeenCalledWith('user1', 'google');
  });

  it('refreshIfExpired returns existing token if not expired', async () => {
    const futureDate = new Date(Date.now() + 10 * 60 * 1000); // 10 min from now
    repo.getToken.mockResolvedValue({
      access_token: 'valid-token',
      refresh_token: 'refresh-456',
      expires_at: futureDate,
      scopes: ['email'],
    });

    const result = await store.refreshIfExpired('user1', 'google');
    expect(result.accessToken).toBe('valid-token');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('refreshIfExpired refreshes token when expired', async () => {
    const pastDate = new Date(Date.now() - 60 * 1000); // 1 min ago
    repo.getToken.mockResolvedValue({
      access_token: 'expired-token',
      refresh_token: 'refresh-456',
      expires_at: pastDate,
      scopes: ['email'],
    });

    const newExpiry = new Date(Date.now() + 3600 * 1000);
    mockRefresh.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'refresh-456',
      expiresAt: newExpiry,
      scopes: ['email'],
      provider: 'google',
    });

    repo.updateAccessToken.mockResolvedValue({});

    const result = await store.refreshIfExpired('user1', 'google');
    expect(result.accessToken).toBe('new-access-token');
    expect(mockRefresh).toHaveBeenCalledWith(oauthConfig, 'refresh-456');
    expect(repo.updateAccessToken).toHaveBeenCalledWith(
      'user1', 'google', 'new-access-token', newExpiry,
    );
  });

  it('refreshIfExpired throws when no token exists', async () => {
    repo.getToken.mockResolvedValue(null);
    await expect(store.refreshIfExpired('user1', 'google')).rejects.toThrow(
      'No OAuth token found',
    );
  });

  it('refreshIfExpired refreshes token within 60s buffer', async () => {
    // Token expires in 30 seconds — within the 60s buffer
    const almostExpired = new Date(Date.now() + 30 * 1000);
    repo.getToken.mockResolvedValue({
      access_token: 'almost-expired',
      refresh_token: 'refresh-456',
      expires_at: almostExpired,
      scopes: ['email'],
    });

    const newExpiry = new Date(Date.now() + 3600 * 1000);
    mockRefresh.mockResolvedValue({
      accessToken: 'refreshed',
      refreshToken: 'refresh-456',
      expiresAt: newExpiry,
      scopes: ['email'],
      provider: 'google',
    });
    repo.updateAccessToken.mockResolvedValue({});

    const result = await store.refreshIfExpired('user1', 'google');
    expect(result.accessToken).toBe('refreshed');
    expect(mockRefresh).toHaveBeenCalled();
  });
});
