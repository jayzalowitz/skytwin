import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbTokenStore } from '../oauth/db-token-store.js';

const microsoftConfig = {
  clientId: 'microsoft-client',
  clientSecret: '',
  redirectUri: 'http://localhost/callback',
  tenant: 'common',
};

function createMockRepo() {
  return {
    getToken: vi.fn(),
    saveToken: vi.fn(),
    deleteToken: vi.fn(),
    updateAccessToken: vi.fn(),
  };
}

describe('DbTokenStore Microsoft refresh scope authority', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['omitted', {}],
    ['empty', { scope: '' }],
  ])('preserves persisted scopes for an expired grant when provider scope is %s', async (
    _name,
    scopeResponse,
  ) => {
    const repo = createMockRepo();
    repo.getToken.mockResolvedValue({
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      expires_at: new Date(Date.now() - 60_000),
      scopes: ['Mail.Read', 'offline_access'],
    });
    repo.updateAccessToken.mockResolvedValue({});
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token',
        expires_in: 3600,
        ...scopeResponse,
      }),
    });
    const store = new DbTokenStore(repo, undefined, microsoftConfig);

    const result = await store.refreshIfExpired('user-1', 'microsoft');

    expect(result.scopes).toEqual(['Mail.Read', 'offline_access']);
    expect(repo.updateAccessToken).toHaveBeenCalledOnce();
  });

  it('rejects an explicit changed scope set before writing credentials', async () => {
    const repo = createMockRepo();
    repo.getToken.mockResolvedValue({
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      expires_at: new Date(Date.now() - 60_000),
      scopes: ['Mail.Read', 'offline_access'],
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'narrower-token',
        expires_in: 3600,
        scope: 'offline_access',
      }),
    });
    const store = new DbTokenStore(repo, undefined, microsoftConfig);

    await expect(store.refreshIfExpired('user-1', 'microsoft')).rejects.toThrow(
      /changed or invalid scope grant/,
    );
    expect(repo.updateAccessToken).not.toHaveBeenCalled();
  });
});
