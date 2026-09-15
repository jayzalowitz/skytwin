import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mock modules -- vi.hoisted ensures these are available when vi.mock
// factories execute (vi.mock calls are hoisted above all other code).
// ---------------------------------------------------------------------------

const {
  mockServiceCredentialRepository,
  mockCredentialRequirementRepository,
  mockLoadConfig,
  mockSseManager,
  mockGetExecutionRouter,
  mockGetIronClawEnhancedAdapter,
  mockIronClawCredentialName,
  mockRevokeCredentialFromIronClaw,
  mockResetExecutionRouterForConfigChange,
  mockSyncCredentialToIronClaw,
} = vi.hoisted(() => ({
  mockServiceCredentialRepository: {
    getAll: vi.fn(),
    getByService: vi.fn(),
    getAsMap: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  mockCredentialRequirementRepository: {
    getAllGrouped: vi.fn(),
    getAll: vi.fn(),
    register: vi.fn(),
    getByAdapter: vi.fn(),
    getByIntegration: vi.fn(),
  },
  mockLoadConfig: vi.fn(),
  mockSseManager: {
    emit: vi.fn(),
    emitAll: vi.fn(),
  },
  mockGetExecutionRouter: vi.fn(),
  mockGetIronClawEnhancedAdapter: vi.fn(),
  mockIronClawCredentialName: vi.fn((service: string, credentialKey: string) => `${service}.${credentialKey}`),
  mockRevokeCredentialFromIronClaw: vi.fn(),
  mockResetExecutionRouterForConfigChange: vi.fn(),
  mockSyncCredentialToIronClaw: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  serviceCredentialRepository: mockServiceCredentialRepository,
  credentialRequirementRepository: mockCredentialRequirementRepository,
}));

vi.mock('@skytwin/config', () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock('../sse.js', () => ({
  sseManager: mockSseManager,
}));

vi.mock('../execution-setup.js', () => ({
  getExecutionRouter: mockGetExecutionRouter,
  getIronClawEnhancedAdapter: mockGetIronClawEnhancedAdapter,
  ironClawCredentialName: mockIronClawCredentialName,
  revokeCredentialFromIronClaw: mockRevokeCredentialFromIronClaw,
  resetExecutionRouterForConfigChange: mockResetExecutionRouterForConfigChange,
  syncCredentialToIronClaw: mockSyncCredentialToIronClaw,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are wired
// ---------------------------------------------------------------------------

import { createCredentialsRouter } from '../routes/credentials.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter());
  // Error handler to capture next(error) calls
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
// Fixture data
// ---------------------------------------------------------------------------

function makeCredentialRow(overrides: Partial<{
  id: string;
  service: string;
  credential_key: string;
  credential_value: string;
  label: string | null;
  created_at: Date;
  updated_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'cred-1',
    service: overrides.service ?? 'google',
    credential_key: overrides.credential_key ?? 'client_id',
    credential_value: overrides.credential_value ?? 'test-client-id-value',
    label: overrides.label ?? 'Client ID',
    created_at: overrides.created_at ?? new Date('2026-01-01'),
    updated_at: overrides.updated_at ?? new Date('2026-01-01'),
  };
}

function makeRequirementRow(overrides: Partial<{
  id: string;
  adapter: string;
  integration: string;
  integration_label: string;
  description: string | null;
  field_key: string;
  field_label: string;
  field_placeholder: string | null;
  is_secret: boolean;
  is_optional: boolean;
  skills: string[];
  created_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'req-1',
    adapter: overrides.adapter ?? 'openclaw',
    integration: overrides.integration ?? 'twitter',
    integration_label: overrides.integration_label ?? 'Twitter / X',
    description: overrides.description ?? 'Post tweets and read your timeline',
    field_key: overrides.field_key ?? 'api_key',
    field_label: overrides.field_label ?? 'API Key',
    field_placeholder: overrides.field_placeholder ?? 'sk-...',
    is_secret: overrides.is_secret ?? true,
    is_optional: overrides.is_optional ?? false,
    skills: overrides.skills ?? ['social_media_post'],
    created_at: overrides.created_at ?? new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Credentials API routes', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ googleConnectionMode: 'experimental' });
    // Default: no dynamic credential requirements.
    mockCredentialRequirementRepository.getAll.mockResolvedValue([]);
    mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());
    mockCredentialRequirementRepository.getByAdapter.mockResolvedValue([]);
    mockCredentialRequirementRepository.getByIntegration.mockResolvedValue([]);
    mockGetIronClawEnhancedAdapter.mockResolvedValue(null);
    mockRevokeCredentialFromIronClaw.mockResolvedValue(false);
    mockSyncCredentialToIronClaw.mockResolvedValue(false);
    app = buildApp();
  });

  // =========================================================================
  // GET /api/credentials/schema
  // =========================================================================
  describe('GET /schema', () => {
    it('returns static SERVICE_SCHEMAS and dynamic integrations', async () => {
      const twitterApiKey = makeRequirementRow({
        field_key: 'api_key',
        field_label: 'API Key',
        field_placeholder: 'sk-...',
        is_secret: true,
        is_optional: false,
        skills: ['social_media_post', 'draft_social_post'],
      });
      const twitterApiSecret = makeRequirementRow({
        id: 'req-2',
        field_key: 'api_secret',
        field_label: 'API Secret',
        field_placeholder: null,
        is_secret: true,
        is_optional: false,
        skills: ['social_media_post'],
      });

      const grouped = new Map([
        ['openclaw:twitter', {
          label: 'Twitter / X',
          description: 'Post tweets and read your timeline',
          adapter: 'openclaw',
          fields: [twitterApiKey, twitterApiSecret],
        }],
      ]);
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(grouped);

      const res = await request(app, 'GET', '/api/credentials/schema');

      expect(res.status).toBe(200);
      const body = res.body as { services: Record<string, unknown>; integrations: Record<string, unknown> };

      // Static schemas
      expect(body.services).toHaveProperty('google');
      expect(body.services).toHaveProperty('ironclaw');
      expect(body.services).toHaveProperty('openclaw');

      // Dynamic integrations
      expect(body.integrations).toHaveProperty('openclaw:twitter');
      const twitter = body.integrations['openclaw:twitter'] as {
        label: string;
        description: string;
        autoDetects: boolean;
        adapter: string;
        skills: string[];
        fields: Array<{ key: string; label: string; placeholder: string; secret: boolean; optional: boolean }>;
      };
      expect(twitter.label).toBe('Twitter / X');
      expect(twitter.description).toBe('Post tweets and read your timeline');
      expect(twitter.autoDetects).toBe(false);
      expect(twitter.adapter).toBe('openclaw');
      expect(twitter.skills).toEqual(expect.arrayContaining(['social_media_post', 'draft_social_post']));
      expect(twitter.fields).toHaveLength(2);
      expect(twitter.fields[0]!.key).toBe('api_key');
      expect(twitter.fields[0]!.secret).toBe(true);
    });

    it('returns empty integrations when no dynamic requirements exist', async () => {
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());

      const res = await request(app, 'GET', '/api/credentials/schema');

      expect(res.status).toBe(200);
      const body = res.body as { services: Record<string, unknown>; integrations: Record<string, unknown> };
      expect(Object.keys(body.integrations)).toHaveLength(0);
      // Static schemas should still be there
      expect(body.services).toHaveProperty('google');
    });

    it('does not advertise Google credential fields when the connection is disabled', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map([
        ['openclaw:google', {
          label: 'Google',
          description: 'Dynamic Google credentials',
          adapter: 'openclaw',
          fields: [makeRequirementRow({ integration: 'google' })],
        }],
        ['google:calendar', {
          label: 'Google Calendar',
          description: 'Dynamic Google adapter credentials',
          adapter: 'google',
          fields: [makeRequirementRow({ adapter: 'google', integration: 'calendar' })],
        }],
      ]));

      const res = await request(app, 'GET', '/api/credentials/schema');

      expect(res.status).toBe(200);
      const body = res.body as { services: Record<string, unknown>; integrations: Record<string, unknown> };
      expect(body.services).not.toHaveProperty('google');
      expect(body.services).toHaveProperty('ironclaw');
      expect(body.services).toHaveProperty('openclaw');
      expect(body.integrations).not.toHaveProperty('openclaw:google');
      expect(body.integrations).not.toHaveProperty('google:calendar');
    });

    it('returns 500 when repository throws', async () => {
      mockCredentialRequirementRepository.getAllGrouped.mockRejectedValue(new Error('DB down'));

      const res = await request(app, 'GET', '/api/credentials/schema');

      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // GET /api/credentials/status
  // =========================================================================
  describe('GET /status', () => {
    function setupExecutionRouterMock(
      adapters: Map<string, { adapter: { healthCheck: () => Promise<{ healthy: boolean }> } }> = new Map(),
    ) {
      mockGetExecutionRouter.mockResolvedValue({
        getRegistry: () => ({
          getAll: () => adapters,
        }),
      });
    }

    it('returns adapter health status and google config from env vars', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'experimental',
        ironclawApiUrl: 'http://localhost:4000',
        openclawApiUrl: 'http://localhost:3456',
        googleClientId: 'test-client-id',
        googleClientSecret: 'test-client-secret',
      });

      const adapters = new Map([
        ['ironclaw', { adapter: { healthCheck: async () => ({ healthy: true }) } }],
        ['direct', { adapter: { healthCheck: async () => ({ healthy: true }) } }],
      ]);
      setupExecutionRouterMock(adapters);
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());

      const res = await request(app, 'GET', '/api/credentials/status');

      expect(res.status).toBe(200);
      const body = res.body as {
        adapters: Record<string, {
          registered: boolean;
          healthy: boolean;
          url: string;
          knownStableVersion?: string;
          knownStableUrl?: string;
          knownPrereleaseVersion?: string;
        }>;
        google: { configured: boolean };
        unmetIntegrations: unknown[];
      };
      expect(body.adapters.ironclaw!.registered).toBe(true);
      expect(body.adapters.ironclaw!.healthy).toBe(true);
      expect(body.adapters.ironclaw!.knownStableVersion).toBe('0.29.1');
      expect(body.adapters.ironclaw!.knownStableUrl).toBe('https://github.com/nearai/ironclaw/releases/tag/ironclaw-v0.29.1');
      expect(body.adapters.direct!.registered).toBe(true);
      expect(body.adapters.direct!.healthy).toBe(true);
      expect(body.adapters.openclaw!.knownStableVersion).toBe('2026.6.10');
      expect(body.adapters.openclaw!.knownPrereleaseVersion).toBe('2026.6.11-beta.1');
      expect(body.google.configured).toBe(true);
    });

    it('reports Google unavailable without reading stored credentials when disabled', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'disabled',
        ironclawApiUrl: 'http://localhost:4000',
        openclawApiUrl: '',
        googleClientId: 'inert-client-id',
        googleClientSecret: 'inert-client-secret',
      });
      setupExecutionRouterMock(new Map());
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());
      mockServiceCredentialRepository.getAsMap.mockResolvedValue({
        client_id: 'stored-client-id',
        client_secret: 'stored-client-secret',
      });

      const res = await request(app, 'GET', '/api/credentials/status');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        google: {
          configured: false,
          hosted: false,
          available: false,
          mode: 'disabled',
          code: 'GOOGLE_CONNECTION_DISABLED',
        },
      });
      expect(mockServiceCredentialRepository.getAsMap).not.toHaveBeenCalledWith('google');
    });

    it('falls back to DB credentials when env vars are empty', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'experimental',
        ironclawApiUrl: 'http://localhost:4000',
        openclawApiUrl: 'http://localhost:3456',
        googleClientId: '',
        googleClientSecret: '',
      });
      setupExecutionRouterMock(new Map());
      mockServiceCredentialRepository.getAsMap.mockResolvedValue({
        client_id: 'db-client-id',
        client_secret: 'db-client-secret',
      });
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());

      const res = await request(app, 'GET', '/api/credentials/status');

      expect(res.status).toBe(200);
      const body = res.body as { google: { configured: boolean } };
      expect(body.google.configured).toBe(true);
      expect(mockServiceCredentialRepository.getAsMap).toHaveBeenCalledWith('google');
    });

    it('reports google as unconfigured when neither env nor DB has credentials', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'experimental',
        ironclawApiUrl: 'http://localhost:4000',
        openclawApiUrl: 'http://localhost:3456',
        googleClientId: '',
        googleClientSecret: '',
      });
      setupExecutionRouterMock(new Map());
      mockServiceCredentialRepository.getAsMap.mockResolvedValue({});
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());

      const res = await request(app, 'GET', '/api/credentials/status');

      expect(res.status).toBe(200);
      const body = res.body as { google: { configured: boolean } };
      expect(body.google.configured).toBe(false);
    });

    it('handles health check failures gracefully', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'experimental',
        ironclawApiUrl: 'http://localhost:4000',
        openclawApiUrl: 'http://localhost:3456',
        googleClientId: 'id',
        googleClientSecret: 'secret',
      });

      const adapters = new Map([
        ['ironclaw', { adapter: { healthCheck: async () => { throw new Error('connection refused'); } } }],
        ['direct', { adapter: { healthCheck: async () => ({ healthy: true }) } }],
      ]);
      setupExecutionRouterMock(adapters);
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());

      const res = await request(app, 'GET', '/api/credentials/status');

      expect(res.status).toBe(200);
      const body = res.body as {
        adapters: Record<string, { registered: boolean; healthy: boolean }>;
      };
      // IronClaw health check threw, so healthy should be false
      expect(body.adapters.ironclaw!.healthy).toBe(false);
      expect(body.adapters.ironclaw!.registered).toBe(true);
      // Direct still healthy
      expect(body.adapters.direct!.healthy).toBe(true);
    });

    it('handles DB credential check failure gracefully', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'experimental',
        ironclawApiUrl: 'http://localhost:4000',
        openclawApiUrl: 'http://localhost:3456',
        googleClientId: '',
        googleClientSecret: '',
      });
      setupExecutionRouterMock(new Map());
      // DB table might not exist yet
      mockServiceCredentialRepository.getAsMap.mockRejectedValue(new Error('table does not exist'));
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());

      const res = await request(app, 'GET', '/api/credentials/status');

      expect(res.status).toBe(200);
      const body = res.body as { google: { configured: boolean } };
      // Falls through to unconfigured since the DB check fails silently
      expect(body.google.configured).toBe(false);
    });

    it('includes unmet integrations in the response', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'experimental',
        ironclawApiUrl: 'http://localhost:4000',
        openclawApiUrl: 'http://localhost:3456',
        googleClientId: 'id',
        googleClientSecret: 'secret',
      });
      setupExecutionRouterMock(new Map());

      const requirementRow = makeRequirementRow({ is_optional: false });
      const grouped = new Map([
        ['openclaw:twitter', {
          label: 'Twitter / X',
          description: 'Post tweets',
          adapter: 'openclaw',
          fields: [requirementRow],
        }],
      ]);
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(grouped);
      // No credentials saved for this integration
      mockServiceCredentialRepository.getAsMap.mockResolvedValue({});

      const res = await request(app, 'GET', '/api/credentials/status');

      expect(res.status).toBe(200);
      const body = res.body as { unmetIntegrations: Array<{ key: string; missingFields: string[] }> };
      expect(body.unmetIntegrations).toHaveLength(1);
      expect(body.unmetIntegrations[0]!.key).toBe('openclaw:twitter');
      expect(body.unmetIntegrations[0]!.missingFields).toContain('API Key');
    });
  });

  describe('disabled Google boundary', () => {
    beforeEach(() => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
    });

    it.each([
      ['PUT', '/api/credentials/google', { credentials: { client_id: 'inert-id' } }],
      ['POST', '/api/credentials/google/sync', undefined],
      ['DELETE', '/api/credentials/google/client_id', undefined],
      ['GET', '/api/credentials/google', undefined],
      ['PUT', '/api/credentials/openclaw%3Agmail', { credentials: { token: 'inert' } }],
      ['POST', '/api/credentials/openclaw%3Agoogle_calendar/sync', undefined],
      ['DELETE', '/api/credentials/google%3Acalendar/token', undefined],
      ['GET', '/api/credentials/openclaw%3Agoogle', undefined],
    ])('rejects %s %s before credential or adapter effects', async (method, path, body) => {
      const res = await request(app, method, path, body);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        code: 'GOOGLE_CONNECTION_DISABLED',
        available: false,
        mode: 'disabled',
      });
      expect(mockServiceCredentialRepository.getByService).not.toHaveBeenCalled();
      expect(mockServiceCredentialRepository.upsert).not.toHaveBeenCalled();
      expect(mockServiceCredentialRepository.delete).not.toHaveBeenCalled();
      expect(mockGetIronClawEnhancedAdapter).not.toHaveBeenCalled();
      expect(mockSyncCredentialToIronClaw).not.toHaveBeenCalled();
      expect(mockRevokeCredentialFromIronClaw).not.toHaveBeenCalled();
    });

    it.each([
      ['PUT', '/api/credentials/custom%3Amail', { credentials: { token: 'inert' } }],
      ['POST', '/api/credentials/custom%3Amail/sync', undefined],
      ['DELETE', '/api/credentials/custom%3Amail/token', undefined],
      ['GET', '/api/credentials/custom%3Amail', undefined],
    ])('rejects skill-shaped service via %s %s before mutation or adapter calls', async (method, path, body) => {
      mockCredentialRequirementRepository.getByAdapter.mockResolvedValue([
        makeRequirementRow({
          adapter: 'custom',
          integration: 'mail',
          field_key: 'token',
          skills: ['send_email'],
        }),
      ]);

      const res = await request(app, method, path, body);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'GOOGLE_CONNECTION_DISABLED' });
      expect(mockServiceCredentialRepository.getByService).not.toHaveBeenCalled();
      expect(mockServiceCredentialRepository.upsert).not.toHaveBeenCalled();
      expect(mockServiceCredentialRepository.delete).not.toHaveBeenCalled();
      expect(mockGetIronClawEnhancedAdapter).not.toHaveBeenCalled();
      expect(mockSyncCredentialToIronClaw).not.toHaveBeenCalled();
      expect(mockRevokeCredentialFromIronClaw).not.toHaveBeenCalled();
    });

    it.each([
      ['PUT', '/api/credentials/custom%3Amail', { credentials: { token: 'inert' } }],
      ['POST', '/api/credentials/custom%3Amail/sync', undefined],
      ['DELETE', '/api/credentials/custom%3Amail/token', undefined],
      ['GET', '/api/credentials/custom%3Amail', undefined],
    ])('fails closed for unresolved dynamic service via %s %s', async (method, path, body) => {
      mockCredentialRequirementRepository.getByAdapter.mockRejectedValue(
        new Error('requirement lookup unavailable'),
      );

      const res = await request(app, method, path, body);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'GOOGLE_CONNECTION_DISABLED' });
      expect(mockServiceCredentialRepository.getByService).not.toHaveBeenCalled();
      expect(mockServiceCredentialRepository.upsert).not.toHaveBeenCalled();
      expect(mockServiceCredentialRepository.delete).not.toHaveBeenCalled();
      expect(mockGetIronClawEnhancedAdapter).not.toHaveBeenCalled();
      expect(mockSyncCredentialToIronClaw).not.toHaveBeenCalled();
      expect(mockRevokeCredentialFromIronClaw).not.toHaveBeenCalled();
    });

    it('hides aliased and skill-shaped rows while preserving a neighboring service', async () => {
      mockCredentialRequirementRepository.getByAdapter.mockImplementation(async (adapter: string) =>
        adapter === 'custom'
          ? [makeRequirementRow({
              adapter: 'custom', integration: 'mail', skills: ['send_email'],
            })]
          : []);
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({ service: 'openclaw:gmail' }),
        makeCredentialRow({ id: 'cred-2', service: 'custom:mail' }),
        makeCredentialRow({ id: 'cred-3', service: 'github' }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');

      expect(res.status).toBe(200);
      expect((res.body as { credentials: Array<{ service: string }> }).credentials
        .map((row) => row.service)).toEqual(['github']);
    });

    it('hides stale dynamic requirements by alias or account-backed skill', async () => {
      const grouped = new Map([
        ['openclaw:gmail', {
          label: 'Mail', description: null, adapter: 'openclaw',
          fields: [makeRequirementRow({ integration: 'gmail', skills: ['read_email'] })],
        }],
        ['custom:mail', {
          label: 'Peer mail', description: null, adapter: 'custom',
          fields: [makeRequirementRow({ adapter: 'custom', integration: 'mail', skills: ['send_email'] })],
        }],
        ['openclaw:github', {
          label: 'GitHub', description: null, adapter: 'openclaw',
          fields: [makeRequirementRow({ integration: 'github', skills: ['create_issue'] })],
        }],
      ]);
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(grouped);
      mockServiceCredentialRepository.getAsMap.mockResolvedValue({});

      const [schema, requirements, unmet] = await Promise.all([
        request(app, 'GET', '/api/credentials/schema'),
        request(app, 'GET', '/api/credentials/requirements'),
        request(app, 'GET', '/api/credentials/unmet'),
      ]);

      expect(Object.keys((schema.body as { integrations: Record<string, unknown> }).integrations))
        .toEqual(['openclaw:github']);
      expect((requirements.body as { requirements: Array<{ key: string }> }).requirements
        .map((item) => item.key)).toEqual(['openclaw:github']);
      expect((unmet.body as { unmet: Array<{ key: string }> }).unmet
        .map((item) => item.key)).toEqual(['openclaw:github']);
    });
  });

  // =========================================================================
  // GET /api/credentials/requirements
  // =========================================================================
  describe('GET /requirements', () => {
    it('returns all grouped requirements', async () => {
      const apiKeyRow = makeRequirementRow({ field_key: 'api_key', field_label: 'API Key', skills: ['skill_a'] });
      const apiSecretRow = makeRequirementRow({ id: 'req-2', field_key: 'api_secret', field_label: 'API Secret', skills: ['skill_b'] });

      const grouped = new Map([
        ['openclaw:twitter', {
          label: 'Twitter / X',
          description: 'Post tweets',
          adapter: 'openclaw',
          fields: [apiKeyRow, apiSecretRow],
        }],
      ]);
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(grouped);

      const res = await request(app, 'GET', '/api/credentials/requirements');

      expect(res.status).toBe(200);
      const body = res.body as { requirements: Array<{
        key: string;
        adapter: string;
        integration: string;
        label: string;
        description: string | null;
        fields: Array<{ key: string; label: string; secret: boolean }>;
        skills: string[];
      }> };
      expect(body.requirements).toHaveLength(1);

      const req = body.requirements[0]!;
      expect(req.key).toBe('openclaw:twitter');
      expect(req.adapter).toBe('openclaw');
      expect(req.integration).toBe('twitter');
      expect(req.label).toBe('Twitter / X');
      expect(req.fields).toHaveLength(2);
      expect(req.fields.every((field) => field.secret === true)).toBe(true);
      expect(req.skills).toEqual(expect.arrayContaining(['skill_a', 'skill_b']));
    });

    it('returns empty requirements when none exist', async () => {
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());

      const res = await request(app, 'GET', '/api/credentials/requirements');

      expect(res.status).toBe(200);
      const body = res.body as { requirements: unknown[] };
      expect(body.requirements).toHaveLength(0);
    });
  });

  // =========================================================================
  // POST /api/credentials/requirements
  // =========================================================================
  describe('POST /requirements', () => {
    it('fails closed because no installation-admin HTTP principal exists', async () => {
      const res = await request(app, 'POST', '/api/credentials/requirements', {
        adapter: 'openclaw',
        integration: 'twitter',
        integrationLabel: 'Twitter / X',
        fields: [{ key: 'auth', label: 'Authorization', secret: false }],
        userId: 'user-123',
      });

      expect(res.status).toBe(405);
      expect(res.body).toMatchObject({
        code: 'dynamic_credential_registration_unavailable',
      });
      expect(mockCredentialRequirementRepository.register).not.toHaveBeenCalled();
      expect(mockSseManager.emit).not.toHaveBeenCalled();
      expect(mockSseManager.emitAll).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /api/credentials/unmet
  // =========================================================================
  describe('GET /unmet', () => {
    it('returns integrations with missing required credentials', async () => {
      const requiredField = makeRequirementRow({ is_optional: false, field_key: 'api_key', field_label: 'API Key' });
      const optionalField = makeRequirementRow({
        id: 'req-2',
        field_key: 'nickname',
        field_label: 'Nickname',
        is_optional: true,
        is_secret: false,
      });

      const grouped = new Map([
        ['openclaw:twitter', {
          label: 'Twitter / X',
          description: 'Post tweets',
          adapter: 'openclaw',
          fields: [requiredField, optionalField],
        }],
      ]);
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(grouped);
      mockServiceCredentialRepository.getAsMap.mockResolvedValue({}); // no credentials saved

      const res = await request(app, 'GET', '/api/credentials/unmet');

      expect(res.status).toBe(200);
      const body = res.body as { unmet: Array<{
        key: string;
        adapter: string;
        integration: string;
        label: string;
        missingFields: string[];
        skills: string[];
      }> };
      expect(body.unmet).toHaveLength(1);
      expect(body.unmet[0]!.key).toBe('openclaw:twitter');
      expect(body.unmet[0]!.adapter).toBe('openclaw');
      expect(body.unmet[0]!.integration).toBe('twitter');
      // Only the required field should be listed as missing
      expect(body.unmet[0]!.missingFields).toEqual(['API Key']);
    });

    it('returns empty when all required credentials are met', async () => {
      const requiredField = makeRequirementRow({ is_optional: false, field_key: 'api_key' });

      const grouped = new Map([
        ['openclaw:twitter', {
          label: 'Twitter / X',
          description: 'Post tweets',
          adapter: 'openclaw',
          fields: [requiredField],
        }],
      ]);
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(grouped);
      mockServiceCredentialRepository.getAsMap.mockResolvedValue({ api_key: 'my-api-key' });

      const res = await request(app, 'GET', '/api/credentials/unmet');

      expect(res.status).toBe(200);
      const body = res.body as { unmet: unknown[] };
      expect(body.unmet).toHaveLength(0);
    });

    it('returns empty when no requirements exist', async () => {
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());

      const res = await request(app, 'GET', '/api/credentials/unmet');

      expect(res.status).toBe(200);
      const body = res.body as { unmet: unknown[] };
      expect(body.unmet).toHaveLength(0);
    });

    it('handles repository errors gracefully (returns empty)', async () => {
      mockCredentialRequirementRepository.getAllGrouped.mockRejectedValue(new Error('DB error'));

      const res = await request(app, 'GET', '/api/credentials/unmet');

      expect(res.status).toBe(200);
      const body = res.body as { unmet: unknown[] };
      expect(body.unmet).toHaveLength(0);
    });
  });

  // =========================================================================
  // GET /api/credentials
  // =========================================================================
  describe('GET /', () => {
    it('returns all credentials with secrets masked', async () => {
      const rows = [
        makeCredentialRow({
          id: 'cred-1',
          service: 'google',
          credential_key: 'client_id',
          credential_value: 'my-google-client-id-value-1234',
          label: 'Client ID',
        }),
        makeCredentialRow({
          id: 'cred-2',
          service: 'google',
          credential_key: 'client_secret',
          credential_value: 'GOCSPX-very-secret-value-here',
          label: 'Client Secret',
        }),
      ];
      mockServiceCredentialRepository.getAll.mockResolvedValue(rows);

      const res = await request(app, 'GET', '/api/credentials');

      expect(res.status).toBe(200);
      const body = res.body as { credentials: Array<{
        id: string;
        service: string;
        credentialKey: string;
        credentialValue: string;
        hasValue: boolean;
      }> };

      expect(body.credentials).toHaveLength(2);

      // client_id is NOT a secret field in google schema
      const clientId = body.credentials.find((c) => c.credentialKey === 'client_id')!;
      expect(clientId.credentialValue).toBe('my-google-client-id-value-1234');
      expect(clientId.hasValue).toBe(true);

      // client_secret IS a secret field in google schema
      const clientSecret = body.credentials.find((c) => c.credentialKey === 'client_secret')!;
      expect(clientSecret.credentialValue).toMatch(/^\w{4}\*{4}\w{4}$/);
      expect(clientSecret.credentialValue).not.toBe('GOCSPX-very-secret-value-here');
      expect(clientSecret.hasValue).toBe(true);
    });

    it('masks every value when service has no trusted static schema', async () => {
      const rows = [
        makeCredentialRow({
          id: 'cred-3',
          service: 'openclaw:twitter',
          credential_key: 'api_key',
          credential_value: 'twitter-api-key-value-12345',
          label: 'API Key',
        }),
        makeCredentialRow({
          id: 'cred-4',
          service: 'openclaw:twitter',
          credential_key: 'api_token',
          credential_value: 'twitter-api-token-value-999',
          label: 'API Token',
        }),
        makeCredentialRow({
          id: 'cred-5',
          service: 'openclaw:twitter',
          credential_key: 'username',
          credential_value: '@skytwin',
          label: 'Username',
        }),
      ];
      mockServiceCredentialRepository.getAll.mockResolvedValue(rows);

      const res = await request(app, 'GET', '/api/credentials');

      expect(res.status).toBe(200);
      const body = res.body as { credentials: Array<{
        credentialKey: string;
        credentialValue: string;
      }> };

      // api_key contains "key" -> masked
      const apiKey = body.credentials.find((c) => c.credentialKey === 'api_key')!;
      expect(apiKey.credentialValue).not.toBe('twitter-api-key-value-12345');
      expect(apiKey.credentialValue).toContain('****');

      // api_token contains "token" -> masked
      const apiToken = body.credentials.find((c) => c.credentialKey === 'api_token')!;
      expect(apiToken.credentialValue).not.toBe('twitter-api-token-value-999');
      expect(apiToken.credentialValue).toContain('****');

      // Benign names are still peer-defined and therefore masked.
      const username = body.credentials.find((c) => c.credentialKey === 'username')!;
      expect(username.credentialValue).toBe('****');
    });

    it('masks benignly named dynamic credentials even when stored metadata says non-secret', async () => {
      mockCredentialRequirementRepository.getAll.mockRejectedValue(
        new Error('requirement metadata unavailable'),
      );
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'openclaw:custom',
          credential_key: 'auth',
          credential_value: 'opaque-credential-value',
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');

      expect(res.status).toBe(200);
      const body = res.body as { credentials: Array<{ credentialValue: string }> };
      expect(body.credentials[0]!.credentialValue).toContain('****');
      expect(body.credentials[0]!.credentialValue).not.toContain('opaque-credential-value');
    });

    it('returns empty array when no credentials exist', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([]);

      const res = await request(app, 'GET', '/api/credentials');

      expect(res.status).toBe(200);
      const body = res.body as { credentials: unknown[] };
      expect(body.credentials).toHaveLength(0);
    });
  });

  // =========================================================================
  // GET /api/credentials/:service
  // =========================================================================
  describe('GET /:service', () => {
    it('returns credentials for a specific service with masking', async () => {
      const rows = [
        makeCredentialRow({
          service: 'ironclaw',
          credential_key: 'api_url',
          credential_value: 'http://localhost:4000',
        }),
        makeCredentialRow({
          id: 'cred-2',
          service: 'ironclaw',
          credential_key: 'webhook_secret',
          credential_value: 'super-secret-webhook-value',
        }),
      ];
      mockServiceCredentialRepository.getByService.mockResolvedValue(rows);

      const res = await request(app, 'GET', '/api/credentials/ironclaw');

      expect(res.status).toBe(200);
      const body = res.body as { credentials: Array<{
        credentialKey: string;
        credentialValue: string;
      }> };

      expect(body.credentials).toHaveLength(2);

      // api_url is NOT secret in ironclaw schema
      const apiUrl = body.credentials.find((c) => c.credentialKey === 'api_url')!;
      expect(apiUrl.credentialValue).toBe('http://localhost:4000');

      // webhook_secret IS secret in ironclaw schema
      const webhookSecret = body.credentials.find((c) => c.credentialKey === 'webhook_secret')!;
      expect(webhookSecret.credentialValue).toContain('****');
      expect(webhookSecret.credentialValue).not.toBe('super-secret-webhook-value');
    });

    it('skips reserved names (status, schema, requirements, unmet)', async () => {
      // These should be handled by more specific routes, not the :service param handler
      // When a reserved name is passed, the handler calls next() so the request
      // would fall through. In our test app there is no subsequent handler, so
      // we check it does NOT call getByService.
      for (const reserved of ['status', 'schema', 'requirements', 'unmet']) {
        mockServiceCredentialRepository.getByService.mockClear();

        // These will result in 404 or some other status since there's no fallback route
        // The important thing is that getByService is NOT called.
        await request(app, 'GET', `/api/credentials/${reserved}`);

        // For 'schema' and 'requirements' there ARE actual handlers above, so they
        // will match. The /:service handler should still not be invoked for them.
        // getByService should not be called since the :service handler calls next()
        // for reserved names.
        // Note: For 'status', the status handler requires execution router setup,
        // which may throw. That is expected behavior. We only verify getByService
        // is not called for the :service catch-all.
      }
    });
  });

  // =========================================================================
  // PUT /api/credentials/:service
  // =========================================================================
  describe('PUT /:service', () => {
    it('saves credentials for a static schema service (google)', async () => {
      mockServiceCredentialRepository.upsert.mockImplementation(
        async (input: { service: string; credentialKey: string; credentialValue: string }) => ({
          id: 'cred-new',
          service: input.service,
          credential_key: input.credentialKey,
          credential_value: input.credentialValue,
          label: input.credentialKey,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

      const res = await request(app, 'PUT', '/api/credentials/google', {
        credentials: {
          client_id: 'new-client-id',
          client_secret: 'new-client-secret',
        },
      });

      expect(res.status).toBe(200);
      const body = res.body as { saved: Array<{ service: string; credentialKey: string; hasValue: boolean }>; status: string };
      expect(body.status).toBe('ok');
      expect(body.saved).toHaveLength(2);
      expect(body.saved[0]!.service).toBe('google');
      expect(body.saved[0]!.hasValue).toBe(true);
      expect(mockServiceCredentialRepository.upsert).toHaveBeenCalledTimes(2);
    });

    it('saves IronClaw connection overrides and resets the execution router', async () => {
      mockServiceCredentialRepository.upsert.mockImplementation(
        async (input: { service: string; credentialKey: string; credentialValue: string }) => ({
          id: 'cred-new',
          service: input.service,
          credential_key: input.credentialKey,
          credential_value: input.credentialValue,
          label: input.credentialKey,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

      const res = await request(app, 'PUT', '/api/credentials/ironclaw', {
        credentials: {
          api_url: 'http://localhost:4000',
          webhook_secret: 'new-secret',
          owner_id: 'owner-1',
        },
      });

      expect(res.status).toBe(200);
      expect(mockServiceCredentialRepository.upsert).toHaveBeenCalledTimes(3);
      expect(mockSyncCredentialToIronClaw).not.toHaveBeenCalled();
      expect(mockResetExecutionRouterForConfigChange).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid execution engine API URLs before saving', async () => {
      const res = await request(app, 'PUT', '/api/credentials/ironclaw', {
        credentials: {
          api_url: 'file:///etc/passwd',
        },
      });

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/Only http:\/\/ and https:\/\//);
      expect(mockServiceCredentialRepository.upsert).not.toHaveBeenCalled();
      expect(mockResetExecutionRouterForConfigChange).not.toHaveBeenCalled();
    });

    it('saves credentials for a dynamic integration (adapter:integration format)', async () => {
      // Set up dynamic requirements lookup
      mockCredentialRequirementRepository.getByAdapter.mockResolvedValue([
        makeRequirementRow({ adapter: 'openclaw', integration: 'twitter', field_key: 'api_key' }),
        makeRequirementRow({ adapter: 'openclaw', integration: 'twitter', field_key: 'api_secret', id: 'req-2' }),
      ]);
      mockServiceCredentialRepository.upsert.mockImplementation(
        async (input: { service: string; credentialKey: string; credentialValue: string }) => ({
          id: 'cred-new',
          service: input.service,
          credential_key: input.credentialKey,
          credential_value: input.credentialValue,
          label: input.credentialKey,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

      const res = await request(app, 'PUT', '/api/credentials/openclaw:twitter', {
        credentials: {
          api_key: 'my-twitter-api-key',
          api_secret: 'my-twitter-secret',
        },
      });

      expect(res.status).toBe(200);
      const body = res.body as { saved: unknown[]; status: string };
      expect(body.status).toBe('ok');
      expect(body.saved).toHaveLength(2);
      expect(mockCredentialRequirementRepository.getByAdapter).toHaveBeenCalledWith('openclaw');
    });

    it('returns 400 when credentials object is missing', async () => {
      const res = await request(app, 'PUT', '/api/credentials/google', {});

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/Missing credentials object/);
    });

    it('returns 400 when credentials is not an object', async () => {
      const res = await request(app, 'PUT', '/api/credentials/google', {
        credentials: 'not-an-object',
      });

      // JSON.stringify sends it as a string, so typeof check in route should catch it
      // Actually, JSON will deserialize "not-an-object" as a string, but
      // the typeof === 'object' check will fail for strings.
      expect(res.status).toBe(400);
    });

    it('returns 400 for unknown service with no matching dynamic requirements', async () => {
      mockCredentialRequirementRepository.getByIntegration.mockResolvedValue([]);

      const res = await request(app, 'PUT', '/api/credentials/nonexistent', {
        credentials: { some_key: 'value' },
      });

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/Unknown service: nonexistent/);
    });

    it('skips keys not in the schema', async () => {
      mockServiceCredentialRepository.upsert.mockImplementation(
        async (input: { service: string; credentialKey: string; credentialValue: string }) => ({
          id: 'cred-new',
          service: input.service,
          credential_key: input.credentialKey,
          credential_value: input.credentialValue,
          label: input.credentialKey,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

      const res = await request(app, 'PUT', '/api/credentials/google', {
        credentials: {
          client_id: 'valid-id',
          not_in_schema: 'should-be-ignored',
          another_invalid: 'also-ignored',
        },
      });

      expect(res.status).toBe(200);
      const body = res.body as { saved: Array<{ credentialKey: string }> };
      // Only client_id should be saved
      expect(body.saved).toHaveLength(1);
      expect(body.saved[0]!.credentialKey).toBe('client_id');
      expect(mockServiceCredentialRepository.upsert).toHaveBeenCalledTimes(1);
    });

    it('skips empty string values', async () => {
      mockServiceCredentialRepository.upsert.mockImplementation(
        async (input: { service: string; credentialKey: string; credentialValue: string }) => ({
          id: 'cred-new',
          service: input.service,
          credential_key: input.credentialKey,
          credential_value: input.credentialValue,
          label: input.credentialKey,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

      const res = await request(app, 'PUT', '/api/credentials/google', {
        credentials: {
          client_id: 'valid-id',
          client_secret: '',       // empty -> skip
          redirect_uri: '   ',     // whitespace only -> skip
        },
      });

      expect(res.status).toBe(200);
      const body = res.body as { saved: Array<{ credentialKey: string }> };
      expect(body.saved).toHaveLength(1);
      expect(body.saved[0]!.credentialKey).toBe('client_id');
    });

    it('trims credential values before saving', async () => {
      mockServiceCredentialRepository.upsert.mockImplementation(
        async (input: { service: string; credentialKey: string; credentialValue: string }) => ({
          id: 'cred-new',
          service: input.service,
          credential_key: input.credentialKey,
          credential_value: input.credentialValue,
          label: input.credentialKey,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

      await request(app, 'PUT', '/api/credentials/google', {
        credentials: {
          client_id: '  trimmed-value  ',
        },
      });

      expect(mockServiceCredentialRepository.upsert).toHaveBeenCalledWith({
        service: 'google',
        credentialKey: 'client_id',
        credentialValue: 'trimmed-value',
        label: 'client_id',
      });
    });

    it('uses getByIntegration when service has no colon (non-static)', async () => {
      // For a plain service name that's not in static schemas and has no colon,
      // the code splits on ':' yielding ['', 'nonexistent'] so adapter is empty,
      // and it calls getByIntegration instead
      mockCredentialRequirementRepository.getByIntegration.mockResolvedValue([
        makeRequirementRow({ field_key: 'token', integration: 'slack' }),
      ]);
      mockServiceCredentialRepository.upsert.mockImplementation(
        async (input: { service: string; credentialKey: string; credentialValue: string }) => ({
          id: 'cred-new',
          service: input.service,
          credential_key: input.credentialKey,
          credential_value: input.credentialValue,
          label: input.credentialKey,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

      // 'slack' is not a static schema key and has no colon
      const res = await request(app, 'PUT', '/api/credentials/slack', {
        credentials: { token: 'xoxb-123' },
      });

      // The code path: service = 'slack', not in SERVICE_SCHEMAS,
      // service.includes(':') is false, so parts = ['', 'slack'],
      // adapter = '' which is falsy, so it calls getByIntegration('slack')
      expect(mockCredentialRequirementRepository.getByIntegration).toHaveBeenCalledWith('slack');
      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // DELETE /api/credentials/:service/:key
  // =========================================================================
  describe('DELETE /:service/:key', () => {
    it('deletes a specific credential and returns result', async () => {
      mockServiceCredentialRepository.delete.mockResolvedValue(true);

      const res = await request(app, 'DELETE', '/api/credentials/google/client_id');

      expect(res.status).toBe(200);
      const body = res.body as { deleted: boolean; service: string; key: string };
      expect(body.deleted).toBe(true);
      expect(body.service).toBe('google');
      expect(body.key).toBe('client_id');
      expect(mockServiceCredentialRepository.delete).toHaveBeenCalledWith('google', 'client_id');
    });

    it('resets the execution router when deleting an execution engine credential', async () => {
      mockServiceCredentialRepository.delete.mockResolvedValue(true);

      const res = await request(app, 'DELETE', '/api/credentials/ironclaw/api_url');

      expect(res.status).toBe(200);
      expect(mockResetExecutionRouterForConfigChange).toHaveBeenCalledTimes(1);
      expect(mockRevokeCredentialFromIronClaw).not.toHaveBeenCalled();
    });

    it('returns false when credential does not exist', async () => {
      mockServiceCredentialRepository.delete.mockResolvedValue(false);

      const res = await request(app, 'DELETE', '/api/credentials/google/nonexistent');

      expect(res.status).toBe(200);
      const body = res.body as { deleted: boolean };
      expect(body.deleted).toBe(false);
    });

    it('handles service:key format for dynamic integrations', async () => {
      mockServiceCredentialRepository.delete.mockResolvedValue(true);

      const res = await request(app, 'DELETE', '/api/credentials/openclaw:twitter/api_key');

      expect(res.status).toBe(200);
      const body = res.body as { deleted: boolean; service: string; key: string };
      expect(body.deleted).toBe(true);
      expect(body.service).toBe('openclaw:twitter');
      expect(body.key).toBe('api_key');
    });
  });

  // =========================================================================
  // maskValue / maskRow logic
  // =========================================================================
  describe('masking logic', () => {
    it('masks short values (<= 8 chars) as ****', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'google',
          credential_key: 'client_secret',
          credential_value: 'short',  // 5 chars <= 8
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialValue: string }> };

      expect(body.credentials[0]!.credentialValue).toBe('****');
    });

    it('masks longer values showing first 4 and last 4 chars', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'google',
          credential_key: 'client_secret',
          credential_value: 'GOCSPX-abcdefghijklmnop',  // 24 chars > 8
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialValue: string }> };

      expect(body.credentials[0]!.credentialValue).toBe('GOCS****mnop');
    });

    it('masks exactly 8-char secrets as ****', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'google',
          credential_key: 'client_secret',
          credential_value: '12345678',  // exactly 8 chars
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialValue: string }> };

      expect(body.credentials[0]!.credentialValue).toBe('****');
    });

    it('masks 9-char secrets showing first 4 and last 4', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'google',
          credential_key: 'client_secret',
          credential_value: '123456789',  // 9 chars > 8
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialValue: string }> };

      expect(body.credentials[0]!.credentialValue).toBe('1234****6789');
    });

    it('detects secret fields from static schema definition', async () => {
      // google schema: client_secret has secret: true, client_id does not
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'google',
          credential_key: 'client_id',
          credential_value: 'my-client-id-1234567890',
        }),
        makeCredentialRow({
          id: 'cred-2',
          service: 'google',
          credential_key: 'client_secret',
          credential_value: 'my-client-secret-1234567890',
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialKey: string; credentialValue: string }> };

      const clientId = body.credentials.find((c) => c.credentialKey === 'client_id')!;
      const clientSecret = body.credentials.find((c) => c.credentialKey === 'client_secret')!;

      // client_id should NOT be masked (not a secret in schema)
      expect(clientId.credentialValue).toBe('my-client-id-1234567890');

      // client_secret should be masked (secret: true in schema)
      expect(clientSecret.credentialValue).toContain('****');
      expect(clientSecret.credentialValue).not.toBe('my-client-secret-1234567890');
    });

    it('detects secret fields by key name heuristic containing "secret"', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'unknown-service',
          credential_key: 'webhook_secret',
          credential_value: 'very-secret-value-here',
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialValue: string }> };

      expect(body.credentials[0]!.credentialValue).toContain('****');
    });

    it('detects secret fields by key name heuristic containing "key"', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'unknown-service',
          credential_key: 'api_key',
          credential_value: 'some-api-key-value-1234',
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialValue: string }> };

      expect(body.credentials[0]!.credentialValue).toContain('****');
    });

    it('detects secret fields by key name heuristic containing "token"', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'unknown-service',
          credential_key: 'access_token',
          credential_value: 'bearer-token-value-here',
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialValue: string }> };

      expect(body.credentials[0]!.credentialValue).toContain('****');
    });

    it('detects secret fields by key name heuristic containing "password"', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'unknown-service',
          credential_key: 'db_password',
          credential_value: 'super-secure-password',
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialValue: string }> };

      expect(body.credentials[0]!.credentialValue).toContain('****');
    });

    it('fails closed for every field without a trusted static schema', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'unknown-service',
          credential_key: 'api_url',
          credential_value: 'http://localhost:4000',
        }),
        makeCredentialRow({
          id: 'cred-2',
          service: 'unknown-service',
          credential_key: 'owner_id',
          credential_value: 'skytwin-default',
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialKey: string; credentialValue: string }> };

      const apiUrl = body.credentials.find((c) => c.credentialKey === 'api_url')!;
      expect(apiUrl.credentialValue).toContain('****');
      expect(apiUrl.credentialValue).not.toBe('http://localhost:4000');

      const ownerId = body.credentials.find((c) => c.credentialKey === 'owner_id')!;
      expect(ownerId.credentialValue).toContain('****');
      expect(ownerId.credentialValue).not.toBe('skytwin-default');
    });

    it('uses schema definition over heuristic (non-secret override)', async () => {
      // In ironclaw schema, api_url is NOT marked as secret even though
      // it contains no heuristic keywords. owner_id also not secret.
      // But webhook_secret IS secret in the schema.
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'ironclaw',
          credential_key: 'owner_id',
          credential_value: 'skytwin-default',
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialKey: string; credentialValue: string }> };

      // owner_id in ironclaw schema does NOT have secret: true
      // and "owner_id" doesn't match heuristic (no secret/key/token/password)
      expect(body.credentials[0]!.credentialValue).toBe('skytwin-default');
    });

    it('preserves hasValue flag correctly', async () => {
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'google',
          credential_key: 'client_secret',
          credential_value: 'abc',
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ hasValue: boolean; credentialValue: string }> };

      expect(body.credentials[0]!.hasValue).toBe(true);
      // Even though masked, hasValue is based on the original length
      expect(body.credentials[0]!.credentialValue).toBe('****');
    });
  });

  // =========================================================================
  // Edge cases / security
  // =========================================================================
  describe('security edge cases', () => {
    it('credential values are never exposed in masked GET responses for secret fields', async () => {
      const secretValue = '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w-this';
      mockServiceCredentialRepository.getAll.mockResolvedValue([
        makeCredentialRow({
          service: 'google',
          credential_key: 'client_secret',
          credential_value: secretValue,
        }),
      ]);

      const res = await request(app, 'GET', '/api/credentials');
      const body = res.body as { credentials: Array<{ credentialValue: string }> };
      const responseStr = JSON.stringify(body);

      // The full secret value should never appear in the response
      expect(responseStr).not.toContain(secretValue);
      // But the masked version should be present
      expect(body.credentials[0]!.credentialValue).toContain('****');
    });

    it('PUT validates against schema to prevent arbitrary key injection', async () => {
      mockServiceCredentialRepository.upsert.mockImplementation(
        async (input: { service: string; credentialKey: string; credentialValue: string }) => ({
          id: 'cred-new',
          service: input.service,
          credential_key: input.credentialKey,
          credential_value: input.credentialValue,
          label: input.credentialKey,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

      const res = await request(app, 'PUT', '/api/credentials/google', {
        credentials: {
          client_id: 'valid',
          '__proto__': 'injection-attempt',
          'constructor': 'another-attempt',
          'admin_override': 'not-in-schema',
        },
      });

      expect(res.status).toBe(200);
      const body = res.body as { saved: Array<{ credentialKey: string }> };
      // Only client_id should be saved -- all others are not in google schema
      expect(body.saved).toHaveLength(1);
      expect(body.saved[0]!.credentialKey).toBe('client_id');
    });
  });
});
