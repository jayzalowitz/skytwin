import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mock modules -- vi.hoisted ensures these are available when vi.mock
// factories execute (vi.mock calls are hoisted above all other code).
// ---------------------------------------------------------------------------

const {
  mockUserRepository,
  mockDomainAutonomyRepository,
  mockEscalationTriggerRepository,
  mockAiProviderRepository,
  mockReasoningModeRepository,
  mockTestProviderForReasoningMode,
  mockValidateBaseUrlWithDns,
} = vi.hoisted(() => ({
  mockUserRepository: {
    findById: vi.fn(),
    updateIronClawChannel: vi.fn(),
    updateAutonomySettings: vi.fn(),
  },
  mockDomainAutonomyRepository: {
    getForUser: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  mockEscalationTriggerRepository: {
    getForUser: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockAiProviderRepository: {
    getForUser: vi.fn(),
    getEnabledForUser: vi.fn(),
    getReasoningSnapshotForUser: vi.fn(),
    replaceAll: vi.fn(),
    replaceAllWithReasoningMode: vi.fn(),
  },
  mockReasoningModeRepository: {
    getOrCreateForUser: vi.fn(),
    setForUser: vi.fn(),
    setForUserIfCompatible: vi.fn(),
  },
  mockTestProviderForReasoningMode: vi.fn(),
  mockValidateBaseUrlWithDns: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  userRepository: mockUserRepository,
  domainAutonomyRepository: mockDomainAutonomyRepository,
  escalationTriggerRepository: mockEscalationTriggerRepository,
  aiProviderRepository: mockAiProviderRepository,
  reasoningModeRepository: mockReasoningModeRepository,
}));

vi.mock('@skytwin/shared-types', async () => {
  const actual = await vi.importActual('@skytwin/shared-types');
  return actual;
});

vi.mock('@skytwin/llm-client', async () => {
  const actual = await vi.importActual('@skytwin/llm-client');
  return {
    ...actual,
    LlmClient: { testProviderForReasoningMode: mockTestProviderForReasoningMode },
    validateBaseUrlWithDns: mockValidateBaseUrlWithDns,
  };
});

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are wired
// ---------------------------------------------------------------------------

import { createSettingsRouter } from '../routes/settings.js';
import {
  SKYTWIN_EMAIL_ATTRIBUTION_TEXT,
  SKYTWIN_REPO_URL,
} from '@skytwin/shared-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSettingsRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

/**
 * Lightweight test helper that makes HTTP requests to an Express app
 * without needing supertest. Uses the native Node fetch API against
 * a locally started server.
 */
async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const options: RequestInit = { method, headers };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
      fetch(url, options)
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PUT /api/settings/:userId/ironclaw-channel', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('updates channel successfully', async () => {
    mockUserRepository.updateIronClawChannel.mockResolvedValue({
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      ironclaw_channel: 'telegram',
    });

    const res = await request(app, 'PUT', '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/ironclaw-channel', {
      ironclawChannel: 'telegram',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      ironclawChannel: 'telegram',
    });
    expect(mockUserRepository.updateIronClawChannel).toHaveBeenCalledWith('aaaaaaaa-bbbb-cccc-dddd-000000000001', 'telegram');
  });

  it('returns 400 for empty ironclawChannel', async () => {
    const res = await request(app, 'PUT', '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/ironclaw-channel', {
      ironclawChannel: '',
    });

    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Invalid IronClaw channel/);
    expect(mockUserRepository.updateIronClawChannel).not.toHaveBeenCalled();
  });

  it('returns 400 for missing ironclawChannel', async () => {
    const res = await request(app, 'PUT', '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/ironclaw-channel', {});

    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Invalid IronClaw channel/);
    expect(mockUserRepository.updateIronClawChannel).not.toHaveBeenCalled();
  });

  it('returns 400 for channel with invalid chars', async () => {
    const invalidChannels = ['has spaces', '<script>alert(1)</script>', 'slashes/bad', 'hash#no'];

    for (const channel of invalidChannels) {
      vi.clearAllMocks();

      const res = await request(app, 'PUT', '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/ironclaw-channel', {
        ironclawChannel: channel,
      });

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/Invalid IronClaw channel/);
      expect(mockUserRepository.updateIronClawChannel).not.toHaveBeenCalled();
    }
  });

  it('returns 400 for channel over 64 chars', async () => {
    const longChannel = 'a'.repeat(65);

    const res = await request(app, 'PUT', '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/ironclaw-channel', {
      ironclawChannel: longChannel,
    });

    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Invalid IronClaw channel/);
    expect(mockUserRepository.updateIronClawChannel).not.toHaveBeenCalled();
  });

  it('returns 404 when user not found', async () => {
    mockUserRepository.updateIronClawChannel.mockResolvedValue(null);

    const res = await request(app, 'PUT', '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000099/ironclaw-channel', {
      ironclawChannel: 'telegram',
    });

    expect(res.status).toBe(404);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/User not found/);
  });

  it('accepts valid channels with allowed characters', async () => {
    const validChannels = ['skytwin', 'telegram', 'my.channel_v2', 'discord:general'];

    for (const channel of validChannels) {
      vi.clearAllMocks();

      mockUserRepository.updateIronClawChannel.mockResolvedValue({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        ironclaw_channel: channel,
      });

      const res = await request(app, 'PUT', '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/ironclaw-channel', {
        ironclawChannel: channel,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        ironclawChannel: channel,
      });
      expect(mockUserRepository.updateIronClawChannel).toHaveBeenCalledWith('aaaaaaaa-bbbb-cccc-dddd-000000000001', channel);
    }
  });
});

describe('email attribution settings', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    mockDomainAutonomyRepository.getForUser.mockResolvedValue([]);
    mockEscalationTriggerRepository.getForUser.mockResolvedValue([]);
    mockAiProviderRepository.getReasoningSnapshotForUser.mockResolvedValue({
      providers: [],
      reasoningMode: { mode: 'on_device', requires_confirmation: false },
    });
  });

  it('GET /api/settings/:userId defaults email attribution on and returns the exact footer text', async () => {
    mockUserRepository.findById.mockResolvedValue({
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      trust_tier: 'suggest',
      ironclaw_channel: 'skytwin',
      autonomy_settings: {},
    });

    const res = await request(
      app,
      'GET',
      '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001',
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      emailAttribution: {
        enabled: true,
        text: SKYTWIN_EMAIL_ATTRIBUTION_TEXT,
        repoUrl: SKYTWIN_REPO_URL,
      },
    });
  });

  it('PUT /api/settings/:userId/autonomy persists the email attribution toggle', async () => {
    mockUserRepository.findById.mockResolvedValue({
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      autonomy_settings: { maxDailySpendCents: 50000 },
    });
    mockUserRepository.updateAutonomySettings.mockResolvedValue({
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      autonomy_settings: {
        maxDailySpendCents: 50000,
        emailAttributionSignatureEnabled: false,
      },
    });

    const res = await request(
      app,
      'PUT',
      '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/autonomy',
      { emailAttributionSignatureEnabled: false },
    );

    expect(res.status).toBe(200);
    expect(mockUserRepository.updateAutonomySettings).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      {
        maxDailySpendCents: 50000,
        emailAttributionSignatureEnabled: false,
      },
    );
    expect(res.body).toMatchObject({
      emailAttribution: { enabled: false, text: SKYTWIN_EMAIL_ATTRIBUTION_TEXT },
    });
  });

  it('PUT /api/settings/:userId/autonomy rejects non-boolean email attribution values', async () => {
    mockUserRepository.findById.mockResolvedValue({
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      autonomy_settings: {},
    });

    const res = await request(
      app,
      'PUT',
      '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/autonomy',
      { emailAttributionSignatureEnabled: 'nope' },
    );

    expect(res.status).toBe(400);
    expect(mockUserRepository.updateAutonomySettings).not.toHaveBeenCalled();
  });
});

describe('reasoning mode settings', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAiProviderRepository.getEnabledForUser.mockResolvedValue([]);
    app = buildApp();
  });

  it('persists only a canonical explicit mode', async () => {
    mockReasoningModeRepository.setForUserIfCompatible.mockResolvedValue({
      mode: 'on_device', requires_confirmation: false,
    });
    const accepted = await request(
      app,
      'PUT',
      '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/ai/reasoning-mode',
      { mode: 'on_device' },
    );
    expect(accepted.status).toBe(200);
    expect(mockReasoningModeRepository.setForUserIfCompatible).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      'on_device',
    );

    const rejected = await request(
      app,
      'PUT',
      '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/ai/reasoning-mode',
      { mode: 'private-ish' },
    );
    expect(rejected.status).toBe(400);
  });

  it('refuses a mode that would cross the active provider boundary', async () => {
    mockReasoningModeRepository.setForUserIfCompatible.mockResolvedValue(null);
    const response = await request(
      app,
      'PUT',
      '/api/settings/aaaaaaaa-bbbb-cccc-dddd-000000000001/ai/reasoning-mode',
      { mode: 'on_device' },
    );
    expect(response.status).toBe(409);
    expect(mockReasoningModeRepository.setForUserIfCompatible).toHaveBeenCalledOnce();
  });
});

describe('reasoning-mode provider mutations', () => {
  let app: Express;
  const userId = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateBaseUrlWithDns.mockReset().mockResolvedValue(undefined);
    mockTestProviderForReasoningMode.mockReset();
    mockAiProviderRepository.getForUser.mockResolvedValue([]);
    mockReasoningModeRepository.getOrCreateForUser.mockResolvedValue({
      mode: 'on_device', requires_confirmation: false,
    });
    mockAiProviderRepository.replaceAllWithReasoningMode.mockImplementation(
      async (_userId: string, _mode: string, providers: Array<Record<string, unknown>>) => providers.map((p) => ({
        provider: p['provider'], api_key: p['apiKey'] ?? '', model: p['model'],
        base_url: p['baseUrl'] ?? null, priority: p['priority'], enabled: p['enabled'] ?? true,
      })),
    );
    app = buildApp();
  });

  it('rejects an enabled remote provider before replacing a local-mode chain', async () => {
    const response = await request(app, 'PUT', `/api/settings/${userId}/ai`, {
      reasoningMode: 'on_device',
      providers: [{
        provider: 'openai', apiKey: 'secret', model: 'gpt', priority: 0, enabled: true,
      }],
    });
    expect(response.status).toBe(409);
    expect(mockAiProviderRepository.replaceAllWithReasoningMode).not.toHaveBeenCalled();
  });

  it('ignores disabled remote entries when enforcing an on-device chain', async () => {
    const response = await request(app, 'PUT', `/api/settings/${userId}/ai`, {
      reasoningMode: 'on_device',
      providers: [
        { provider: 'embedded', model: 'managed', priority: 0, enabled: true },
        { provider: 'openai', apiKey: 'secret', model: 'gpt', priority: 1, enabled: false },
      ],
    });
    expect(response.status).toBe(200);
    expect(mockAiProviderRepository.replaceAllWithReasoningMode).toHaveBeenCalledWith(
      userId,
      'on_device',
      expect.any(Array),
    );
  });

  it('accepts the null default endpoint returned by settings GET on save', async () => {
    const response = await request(app, 'PUT', `/api/settings/${userId}/ai`, {
      reasoningMode: 'bring_your_own_provider',
      providers: [{
        provider: 'openai', apiKey: '', model: 'gpt', baseUrl: null,
        priority: 0, enabled: true,
      }],
    });

    expect(response.status).toBe(200);
    expect(mockAiProviderRepository.replaceAllWithReasoningMode).toHaveBeenCalledWith(
      userId,
      'bring_your_own_provider',
      [expect.objectContaining({ baseUrl: undefined })],
    );
  });

  it('requires the mode in the same request as a full provider replacement', async () => {
    const response = await request(app, 'PUT', `/api/settings/${userId}/ai`, {
      providers: [{ provider: 'embedded', model: 'managed', priority: 0, enabled: true }],
    });
    expect(response.status).toBe(400);
    expect(mockAiProviderRepository.replaceAllWithReasoningMode).not.toHaveBeenCalled();
  });

  it('does not persist verified-private-cloud mode without a verified adapter', async () => {
    const response = await request(app, 'PUT', `/api/settings/${userId}/ai`, {
      reasoningMode: 'verified_private_cloud',
      providers: [],
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Verified private cloud requires a verifier-owned provider adapter',
    });
    expect(mockAiProviderRepository.replaceAllWithReasoningMode).not.toHaveBeenCalled();
  });

  it('reports an endpoint credential conflict without accepting the replacement', async () => {
    mockAiProviderRepository.replaceAllWithReasoningMode.mockRejectedValueOnce(
      Object.assign(new Error('must not expose repository details'), {
        code: 'provider_credential_endpoint_changed',
      }),
    );
    const response = await request(app, 'PUT', `/api/settings/${userId}/ai`, {
      reasoningMode: 'bring_your_own_provider',
      providers: [{
        provider: 'openai', model: 'gpt', baseUrl: 'https://new.example/v1', priority: 0,
      }],
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Enter a fresh API key when changing a provider endpoint.',
    });
  });

  it('tests a provider only through the persisted mode boundary', async () => {
    mockTestProviderForReasoningMode.mockResolvedValue({ latencyMs: 2, model: 'managed' });
    const response = await request(app, 'POST', `/api/settings/${userId}/ai/test`, {
      provider: 'ollama', model: 'managed', baseUrl: 'http://localhost:11434',
    });
    expect(response.status).toBe(200);
    expect(mockTestProviderForReasoningMode).toHaveBeenCalledWith(
      'on_device',
      expect.objectContaining({ name: 'ollama', baseUrl: 'http://localhost:11434' }),
    );
    expect(mockValidateBaseUrlWithDns).toHaveBeenCalledWith(
      'http://localhost:11434',
      'ollama',
    );
  });

  it('accepts the null default endpoint returned by settings GET on test', async () => {
    mockReasoningModeRepository.getOrCreateForUser.mockResolvedValue({
      mode: 'bring_your_own_provider', requires_confirmation: false,
    });
    mockTestProviderForReasoningMode.mockResolvedValue({ latencyMs: 2, model: 'gpt' });

    const response = await request(app, 'POST', `/api/settings/${userId}/ai/test`, {
      provider: 'openai', apiKey: 'secret', model: 'gpt', baseUrl: null,
    });

    expect(response.status).toBe(200);
    expect(mockTestProviderForReasoningMode).toHaveBeenCalledWith(
      'bring_your_own_provider',
      expect.objectContaining({ baseUrl: undefined }),
    );
  });

  it('rejects a DNS-unsafe test endpoint before making an inference request', async () => {
    mockReasoningModeRepository.getOrCreateForUser.mockResolvedValue({
      mode: 'bring_your_own_provider', requires_confirmation: false,
    });
    mockValidateBaseUrlWithDns.mockRejectedValue(new Error('DNS target is private'));
    const response = await request(app, 'POST', `/api/settings/${userId}/ai/test`, {
      provider: 'openai', apiKey: 'secret', model: 'gpt', baseUrl: 'https://unsafe.example',
    });
    expect(response.status).toBe(400);
    expect(mockTestProviderForReasoningMode).not.toHaveBeenCalled();
  });

  it('does not send a stored credential to a changed test endpoint authority', async () => {
    mockReasoningModeRepository.getOrCreateForUser.mockResolvedValue({
      mode: 'bring_your_own_provider', requires_confirmation: false,
    });
    mockAiProviderRepository.getForUser.mockResolvedValue([{
      provider: 'openai', api_key: 'stored-secret', model: 'gpt',
      base_url: 'https://gateway.example/v1', priority: 0, enabled: true,
    }]);

    const response = await request(app, 'POST', `/api/settings/${userId}/ai/test`, {
      provider: 'openai', model: 'gpt', baseUrl: 'https://other.example/v1',
    });

    expect(response.status).toBe(409);
    expect(mockTestProviderForReasoningMode).not.toHaveBeenCalled();
  });

  it('may reuse a stored credential for another path on the same test authority', async () => {
    mockReasoningModeRepository.getOrCreateForUser.mockResolvedValue({
      mode: 'bring_your_own_provider', requires_confirmation: false,
    });
    mockAiProviderRepository.getForUser.mockResolvedValue([{
      provider: 'openai', api_key: 'stored-secret', model: 'gpt',
      base_url: 'https://gateway.example/v1', priority: 0, enabled: true,
    }]);
    mockTestProviderForReasoningMode.mockResolvedValue({ latencyMs: 2, model: 'gpt' });

    const response = await request(app, 'POST', `/api/settings/${userId}/ai/test`, {
      provider: 'openai', model: 'gpt', baseUrl: 'https://gateway.example/v2',
    });

    expect(response.status).toBe(200);
    expect(mockTestProviderForReasoningMode).toHaveBeenCalledWith(
      'bring_your_own_provider',
      expect.objectContaining({ apiKey: 'stored-secret', baseUrl: 'https://gateway.example/v2' }),
    );
  });

  it('reuses an omitted Ollama credential only for the literal runtime default', async () => {
    mockAiProviderRepository.getForUser
      .mockResolvedValueOnce([{
        provider: 'ollama', api_key: 'stored-secret', model: 'qwen',
        base_url: null, priority: 0, enabled: true,
      }])
      .mockResolvedValueOnce([{
        provider: 'ollama', api_key: 'stored-secret', model: 'qwen',
        base_url: 'http://127.0.0.1:11434', priority: 0, enabled: true,
      }]);
    mockTestProviderForReasoningMode.mockResolvedValue({ latencyMs: 2, model: 'qwen' });

    const explicitDefault = await request(app, 'POST', `/api/settings/${userId}/ai/test`, {
      provider: 'ollama', model: 'qwen', baseUrl: 'http://127.0.0.1:11434',
    });
    const omittedDefault = await request(app, 'POST', `/api/settings/${userId}/ai/test`, {
      provider: 'ollama', model: 'qwen',
    });

    expect(explicitDefault.status).toBe(200);
    expect(omittedDefault.status).toBe(200);
    expect(mockTestProviderForReasoningMode).toHaveBeenNthCalledWith(
      1,
      'on_device',
      expect.objectContaining({ apiKey: 'stored-secret' }),
    );
    expect(mockTestProviderForReasoningMode).toHaveBeenNthCalledWith(
      2,
      'on_device',
      expect.objectContaining({ apiKey: 'stored-secret', baseUrl: undefined }),
    );
  });

  it('does not reuse an omitted Ollama credential for explicit localhost', async () => {
    mockAiProviderRepository.getForUser.mockResolvedValue([{
      provider: 'ollama', api_key: 'stored-secret', model: 'qwen',
      base_url: null, priority: 0, enabled: true,
    }]);

    const response = await request(app, 'POST', `/api/settings/${userId}/ai/test`, {
      provider: 'ollama', model: 'qwen', baseUrl: 'http://localhost:11434',
    });

    expect(response.status).toBe(409);
    expect(mockTestProviderForReasoningMode).not.toHaveBeenCalled();
  });

  it('does not test providers while a migrated chain awaits confirmation', async () => {
    mockReasoningModeRepository.getOrCreateForUser.mockResolvedValue({
      mode: null, requires_confirmation: true,
    });
    const response = await request(app, 'POST', `/api/settings/${userId}/ai/test`, {
      provider: 'ollama', model: 'managed', baseUrl: 'http://localhost:11434',
    });
    expect(response.status).toBe(409);
    expect(mockTestProviderForReasoningMode).not.toHaveBeenCalled();
  });
});
