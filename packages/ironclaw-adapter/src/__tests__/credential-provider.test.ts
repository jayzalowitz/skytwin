import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockOauthRepository, mockServiceCredentialRepository, mockLoadConfig } = vi.hoisted(() => ({
  mockOauthRepository: {
    getToken: vi.fn(),
    saveToken: vi.fn(),
  },
  mockServiceCredentialRepository: {
    getAsMap: vi.fn(),
  },
  mockLoadConfig: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  oauthRepository: mockOauthRepository,
  serviceCredentialRepository: mockServiceCredentialRepository,
}));

vi.mock('@skytwin/config', () => ({
  loadConfig: mockLoadConfig,
}));

import { DbCredentialProvider, NoopCredentialProvider } from '../credential-provider.js';

describe('DbCredentialProvider', () => {
  const fetchMock = vi.fn();
  let provider: DbCredentialProvider;

  beforeEach(() => {
    provider = new DbCredentialProvider();
    vi.stubGlobal('fetch', fetchMock);
    mockLoadConfig.mockReturnValue({
      googleClientId: 'test-client-id',
      googleClientSecret: 'test-client-secret',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    mockOauthRepository.getToken.mockReset();
    mockOauthRepository.saveToken.mockReset();
    mockServiceCredentialRepository.getAsMap.mockReset();
    mockLoadConfig.mockReset();
  });

  it('returns a valid (non-expired) token directly without refresh', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() + 120_000),
      scopes: ['email', 'calendar'],
    });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({ success: true, accessToken: 'access-123' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockOauthRepository.saveToken).not.toHaveBeenCalled();
  });

  it('returns error when no token found for provider', async () => {
    mockOauthRepository.getToken.mockResolvedValue(null);

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({
      success: false,
      error: 'No OAuth token found for google. Connect the account first.',
    });
  });

  it('returns error when provider is not google and token is expired', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['scope1'],
    });

    const result = await provider.getAccessToken('user_1', 'outlook');

    expect(result).toEqual({
      success: false,
      error: 'OAuth refresh is not implemented for outlook. Reconnect the account.',
    });
  });

  it('returns error when google token is expired and has no refresh_token', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'access-123',
      refresh_token: null,
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
    });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({
      success: false,
      error: 'Google OAuth token is expired and has no refresh token. Reconnect Google.',
    });
  });

  it('successfully refreshes an expired Google token', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email', 'calendar'],
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access-456',
        expires_in: 3600,
        refresh_token: 'new-refresh-789',
      }),
    });

    mockOauthRepository.saveToken.mockResolvedValue({
      access_token: 'new-access-456',
    });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({ success: true, accessToken: 'new-access-456' });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');

    expect(mockOauthRepository.saveToken).toHaveBeenCalledWith(
      'user_1',
      'google',
      'new-access-456',
      'new-refresh-789',
      expect.any(Date),
      ['email', 'calendar'],
    );
  });

  it('concurrent refresh requests for same user+provider return the same promise', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
    });

    let resolveRefresh!: (value: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    fetchMock.mockReturnValue(pendingFetch);

    mockOauthRepository.saveToken.mockResolvedValue({
      access_token: 'new-access-456',
    });

    // Fire two concurrent requests
    const promise1 = provider.getAccessToken('user_1', 'google');
    const promise2 = provider.getAccessToken('user_1', 'google');

    // Resolve the single fetch call
    resolveRefresh({
      ok: true,
      json: async () => ({
        access_token: 'new-access-456',
        expires_in: 3600,
      }),
    } as Response);

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toEqual({ success: true, accessToken: 'new-access-456' });
    expect(result2).toEqual({ success: true, accessToken: 'new-access-456' });
    // fetch should have been called only once despite two getAccessToken calls
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('failed refresh clears the lock so subsequent calls can retry', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
    });

    // First attempt: fetch fails
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const failResult = await provider.getAccessToken('user_1', 'google');
    expect(failResult).toEqual({
      success: false,
      error: 'Google OAuth refresh failed: HTTP 500 Internal Server Error',
    });

    // Second attempt: fetch succeeds (lock should be cleared)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'retry-access',
        expires_in: 3600,
      }),
    });

    mockOauthRepository.saveToken.mockResolvedValue({
      access_token: 'retry-access',
    });

    const retryResult = await provider.getAccessToken('user_1', 'google');
    expect(retryResult).toEqual({ success: true, accessToken: 'retry-access' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to DB credentials when loadConfig returns empty googleClientId/googleClientSecret', async () => {
    mockLoadConfig.mockReturnValue({
      googleClientId: '',
      googleClientSecret: '',
    });

    mockServiceCredentialRepository.getAsMap.mockResolvedValue({
      client_id: 'db-client-id',
      client_secret: 'db-client-secret',
    });

    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access-from-db-creds',
        expires_in: 3600,
      }),
    });

    mockOauthRepository.saveToken.mockResolvedValue({
      access_token: 'new-access-from-db-creds',
    });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({ success: true, accessToken: 'new-access-from-db-creds' });
    expect(mockServiceCredentialRepository.getAsMap).toHaveBeenCalledWith('google');

    // Verify the fetch used the DB credentials
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe('db-client-id');
    expect(body.get('client_secret')).toBe('db-client-secret');
  });

  it('returns error when neither config nor DB has Google client credentials', async () => {
    mockLoadConfig.mockReturnValue({
      googleClientId: '',
      googleClientSecret: '',
    });

    mockServiceCredentialRepository.getAsMap.mockResolvedValue({});

    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
    });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({
      success: false,
      error: 'Google OAuth client credentials are not configured.',
    });
  });
});

describe('NoopCredentialProvider', () => {
  it('returns error for any provider', async () => {
    const provider = new NoopCredentialProvider();

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({
      success: false,
      error: 'No credential provider configured for google.',
    });
  });
});
