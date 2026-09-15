import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock modules -- vi.hoisted ensures these are available when vi.mock
// factories execute (vi.mock calls are hoisted above all other code).
// ---------------------------------------------------------------------------

const {
  mockServiceCredentialRepository,
  mockIronClawToolRepository,
  mockLoadConfig,
  mockIsIronClawEnhancedAdapter,
  mockRealIronClawAdapter,
  mockAdapterRegistry,
  mockExecutionRouterConstructor,
  mockOpenClawAdapter,
  mockCredentialRequirementRepository,
  mockMcpServerRepository,
  mockSseManager,
} = vi.hoisted(() => {
  const registryMap = new Map<string, { adapter: unknown }>();
  const mockRegistry = {
    register: vi.fn(),
    get: vi.fn((name: string) => registryMap.get(name)),
    getAll: vi.fn(() => registryMap),
    _map: registryMap,
  };
  const mockRouter = {
    getRegistry: vi.fn(() => mockRegistry),
  };
  const mockRouterConstructor = vi.fn(function ExecutionRouter(
    _registry: unknown,
    _dispatchAuthority: unknown,
    _admissionGuard?: unknown,
  ) {
    return mockRouter;
  });

  return {
    mockServiceCredentialRepository: {
      getAsMap: vi.fn(),
      getUnsyncedCredentials: vi.fn(),
      markSynced: vi.fn(),
    },
    mockIronClawToolRepository: {
      upsertMany: vi.fn(),
      getSkillSet: vi.fn(),
    },
    mockLoadConfig: vi.fn(),
    mockIsIronClawEnhancedAdapter: vi.fn(),
    mockRealIronClawAdapter: vi.fn(),
    mockAdapterRegistry: mockRegistry,
    mockExecutionRouterConstructor: mockRouterConstructor,
    mockOpenClawAdapter: vi.fn(),
    mockCredentialRequirementRepository: { register: vi.fn(), getAllGrouped: vi.fn() },
    mockMcpServerRepository: { getById: vi.fn(), listSkillNamesForServer: vi.fn() },
    mockSseManager: { emit: vi.fn(), emitAll: vi.fn() },
  };
});

vi.mock('@skytwin/db', () => ({
  serviceCredentialRepository: mockServiceCredentialRepository,
  ironClawToolRepository: mockIronClawToolRepository,
  credentialRequirementRepository: mockCredentialRequirementRepository,
  mcpServerRepository: mockMcpServerRepository,
  executionDispatchLeaseRepository: { start: vi.fn(), terminalize: vi.fn() },
}));

vi.mock('@skytwin/config', () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock('@skytwin/ironclaw-adapter', () => ({
  RealIronClawAdapter: mockRealIronClawAdapter,
  DirectExecutionAdapter: vi.fn(),
  ActionHandlerRegistry: vi.fn(function ActionHandlerRegistry() {
    return { register: vi.fn() };
  }),
  EmailActionHandler: vi.fn(),
  CalendarActionHandler: vi.fn(),
  FinanceActionHandler: vi.fn(),
  TaskActionHandler: vi.fn(),
  SmartHomeActionHandler: vi.fn(),
  SocialActionHandler: vi.fn(),
  DocumentActionHandler: vi.fn(),
  HealthActionHandler: vi.fn(),
  DbCredentialProvider: vi.fn(),
  isIronClawEnhancedAdapter: mockIsIronClawEnhancedAdapter,
}));

vi.mock('@skytwin/execution-router', () => ({
  ExecutionRouter: mockExecutionRouterConstructor,
  AdapterRegistry: vi.fn(function AdapterRegistry() {
    return mockAdapterRegistry;
  }),
  OpenClawAdapter: mockOpenClawAdapter,
  IRONCLAW_TRUST_PROFILE: {},
  OPENCLAW_TRUST_PROFILE: {},
  DIRECT_TRUST_PROFILE: {},
  MCP_HOST_TRUST_PROFILE: {},
  OPENCLAW_SKILLS: new Set<string>(),
  discoverAdapters: vi.fn(),
}));

vi.mock('@skytwin/mcp-host', () => ({
  McpHost: vi.fn(function McpHost() {
    return {};
  }),
}));

vi.mock('../sse.js', () => ({
  sseManager: mockSseManager,
}));

// ---------------------------------------------------------------------------
// Import the functions under test AFTER mocks are wired
// ---------------------------------------------------------------------------

import {
  syncUnsyncedCredentialsToIronClaw,
  refreshIronClawToolCache,
  syncCredentialToIronClaw,
  revokeCredentialFromIronClaw,
  ironClawCredentialName,
  createExecutionRouter,
} from '../execution-setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides: Partial<{
  listCredentials: () => Promise<Array<{ name: string; configuredAt: string }>>;
  registerCredential: (name: string, value: string) => Promise<{ success: boolean }>;
  revokeCredential: (name: string) => Promise<{ success: boolean }>;
  discoverTools: () => Promise<Array<{
    name: string;
    description: string;
    actionTypes: string[];
    requiresCredentials: string[];
  }>>;
}> = {}) {
  return {
    listCredentials: overrides.listCredentials ?? vi.fn().mockResolvedValue([]),
    registerCredential: overrides.registerCredential ?? vi.fn().mockResolvedValue({ success: true }),
    revokeCredential: overrides.revokeCredential ?? vi.fn().mockResolvedValue({ success: true }),
    discoverTools: overrides.discoverTools ?? vi.fn().mockResolvedValue([]),
    // Include enhanced adapter methods so isIronClawEnhancedAdapter can be made to return true
    executeStreaming: vi.fn(),
    sendChatCompletion: vi.fn(),
    createRoutine: vi.fn(),
    listRoutines: vi.fn(),
    deleteRoutine: vi.fn(),
    execute: vi.fn(),
    healthCheck: vi.fn(),
  };
}

function makeCredentialRow(overrides: Partial<{
  id: string;
  service: string;
  credential_key: string;
  credential_value: string;
}> = {}) {
  return {
    id: overrides.id ?? 'cred-1',
    service: overrides.service ?? 'google',
    credential_key: overrides.credential_key ?? 'client_id',
    credential_value: overrides.credential_value ?? 'test-value',
    label: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ironclaw_synced_at: null,
  };
}

/**
 * Set up the mocked execution router singleton so that
 * getIronClawEnhancedAdapter returns the given adapter (or null).
 */
function setupRouterWithAdapter(adapter: ReturnType<typeof makeAdapter> | null) {
  mockLoadConfig.mockReturnValue({});
  mockAdapterRegistry._map.clear();
  if (adapter) {
    mockAdapterRegistry._map.set('ironclaw', { adapter });
    mockIsIronClawEnhancedAdapter.mockReturnValue(true);
  } else {
    mockIsIronClawEnhancedAdapter.mockReturnValue(false);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('execution-setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default config: no IronClaw, no OpenClaw, no plugins
    mockLoadConfig.mockReturnValue({});
    mockIsIronClawEnhancedAdapter.mockReturnValue(false);
    mockAdapterRegistry._map.clear();
    mockServiceCredentialRepository.getAsMap.mockResolvedValue({});
    mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());
    mockMcpServerRepository.getById.mockResolvedValue(null);
    mockMcpServerRepository.listSkillNamesForServer.mockResolvedValue([]);
  });

  // =========================================================================
  // ironClawCredentialName
  // =========================================================================
  describe('ironClawCredentialName', () => {
    it('joins service and key with a dot', () => {
      expect(ironClawCredentialName('google', 'client_secret')).toBe('google.client_secret');
    });
  });

  // =========================================================================
  // syncUnsyncedCredentialsToIronClaw
  // =========================================================================
  describe('syncUnsyncedCredentialsToIronClaw', () => {
    it('registers non-Google credentials and marks them as synced', async () => {
      const adapter = makeAdapter();
      const rows = [
        makeCredentialRow({ service: 'github', credential_key: 'client_id', credential_value: 'id-val' }),
        makeCredentialRow({ id: 'cred-2', service: 'slack', credential_key: 'client_secret', credential_value: 'secret-val' }),
      ];
      mockServiceCredentialRepository.getUnsyncedCredentials.mockResolvedValue(rows);
      mockServiceCredentialRepository.markSynced.mockResolvedValue(null);

      await syncUnsyncedCredentialsToIronClaw(adapter as never);

      // Both credentials should be registered
      expect(adapter.registerCredential).toHaveBeenCalledTimes(2);
      expect(adapter.registerCredential).toHaveBeenCalledWith('github.client_id', 'id-val');
      expect(adapter.registerCredential).toHaveBeenCalledWith('slack.client_secret', 'secret-val');

      // Both should be marked synced
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledTimes(2);
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledWith('github', 'client_id');
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledWith('slack', 'client_secret');
    });

    it('never exports Google credentials while syncing neighboring services', async () => {
      const adapter = makeAdapter({
        listCredentials: vi.fn().mockResolvedValue([
          { name: 'google.client_id', configuredAt: '2026-01-01T00:00:00Z' },
        ]),
      });
      const rows = [
        makeCredentialRow({ service: 'google', credential_key: 'client_id', credential_value: 'id-val' }),
        makeCredentialRow({ id: 'cred-2', service: 'github', credential_key: 'token', credential_value: 'token-val' }),
      ];
      mockServiceCredentialRepository.getUnsyncedCredentials.mockResolvedValue(rows);
      mockServiceCredentialRepository.markSynced.mockResolvedValue(null);

      await syncUnsyncedCredentialsToIronClaw(adapter as never);

      expect(adapter.registerCredential).toHaveBeenCalledTimes(1);
      expect(adapter.registerCredential).toHaveBeenCalledWith('github.token', 'token-val');
      expect(adapter.registerCredential).not.toHaveBeenCalledWith('google.client_id', expect.anything());
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledTimes(1);
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledWith('github', 'token');
      expect(mockServiceCredentialRepository.markSynced).not.toHaveBeenCalledWith('google', 'client_id');
    });

    it('never exports aliased or skill-shaped account credentials', async () => {
      const adapter = makeAdapter();
      const accountRequirement = {
        adapter: 'custom',
        fields: [{ skills: ['send_email'] }],
      };
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map([
        ['custom:mail', accountRequirement],
      ]));
      mockServiceCredentialRepository.getUnsyncedCredentials.mockResolvedValue([
        makeCredentialRow({ service: 'openclaw:gmail', credential_key: 'token' }),
        makeCredentialRow({ id: 'cred-2', service: 'openclaw:google_calendar', credential_key: 'token' }),
        makeCredentialRow({ id: 'cred-3', service: 'custom:mail', credential_key: 'token' }),
        makeCredentialRow({ id: 'cred-4', service: 'microsoft', credential_key: 'client_secret' }),
        makeCredentialRow({ id: 'cred-5', service: 'openclaw:outlook', credential_key: 'token' }),
        makeCredentialRow({ id: 'cred-6', service: 'github', credential_key: 'token' }),
      ]);
      mockServiceCredentialRepository.markSynced.mockResolvedValue(null);

      await syncUnsyncedCredentialsToIronClaw(adapter as never);

      expect(adapter.registerCredential).toHaveBeenCalledTimes(1);
      expect(adapter.registerCredential).toHaveBeenCalledWith('github.token', 'test-value');
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledTimes(1);
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledWith('github', 'token');
    });

    it('never exports an unregistered dynamic credential when classification is empty', async () => {
      const adapter = makeAdapter();
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map());
      mockServiceCredentialRepository.getUnsyncedCredentials.mockResolvedValue([
        makeCredentialRow({ service: 'custom:neutral', credential_key: 'token' }),
        makeCredentialRow({ id: 'cred-2', service: 'github', credential_key: 'token' }),
      ]);
      mockServiceCredentialRepository.markSynced.mockResolvedValue(null);

      await syncUnsyncedCredentialsToIronClaw(adapter as never);

      expect(adapter.registerCredential).toHaveBeenCalledOnce();
      expect(adapter.registerCredential).toHaveBeenCalledWith('github.token', 'test-value');
      expect(adapter.registerCredential).not.toHaveBeenCalledWith('custom:neutral.token', expect.anything());
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledOnce();
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledWith('github', 'token');
    });

    it('handles partial failures via Promise.allSettled — only marks successes as synced', async () => {
      const registerCredential = vi.fn()
        .mockResolvedValueOnce({ success: true })  // first call succeeds
        .mockRejectedValueOnce(new Error('network error'));  // second call fails
      const adapter = makeAdapter({ registerCredential });

      const rows = [
        makeCredentialRow({ service: 'svc-a', credential_key: 'key-a', credential_value: 'val-a' }),
        makeCredentialRow({ id: 'cred-2', service: 'svc-b', credential_key: 'key-b', credential_value: 'val-b' }),
      ];
      mockServiceCredentialRepository.getUnsyncedCredentials.mockResolvedValue(rows);
      mockServiceCredentialRepository.markSynced.mockResolvedValue(null);

      await syncUnsyncedCredentialsToIronClaw(adapter as never);

      // Both were attempted
      expect(registerCredential).toHaveBeenCalledTimes(2);

      // Only the first (successful) credential should be marked synced
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledTimes(1);
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledWith('svc-a', 'key-a');
    });

    it('processes credentials in batches of 5', async () => {
      const adapter = makeAdapter();
      // Create 7 credentials to trigger two batches (5 + 2)
      const rows = Array.from({ length: 7 }, (_, i) =>
        makeCredentialRow({
          id: `cred-${i}`,
          service: `svc-${i}`,
          credential_key: `key-${i}`,
          credential_value: `val-${i}`,
        }),
      );
      mockServiceCredentialRepository.getUnsyncedCredentials.mockResolvedValue(rows);
      mockServiceCredentialRepository.markSynced.mockResolvedValue(null);

      await syncUnsyncedCredentialsToIronClaw(adapter as never);

      expect(adapter.registerCredential).toHaveBeenCalledTimes(7);
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledTimes(7);
    });

    it('does not depend on listCredentials before syncing unsynced rows', async () => {
      const listCredentials = vi.fn().mockRejectedValue(new Error('connection refused'));
      const adapter = makeAdapter({
        listCredentials,
      });
      const rows = [makeCredentialRow({ service: 'github', credential_key: 'token', credential_value: 'val' })];
      mockServiceCredentialRepository.getUnsyncedCredentials.mockResolvedValue(rows);
      mockServiceCredentialRepository.markSynced.mockResolvedValue(null);

      await syncUnsyncedCredentialsToIronClaw(adapter as never);

      expect(listCredentials).not.toHaveBeenCalled();
      expect(adapter.registerCredential).toHaveBeenCalledTimes(1);
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledTimes(1);
    });

    it('handles getUnsyncedCredentials failure gracefully', async () => {
      const adapter = makeAdapter();
      mockServiceCredentialRepository.getUnsyncedCredentials.mockRejectedValue(new Error('DB down'));

      // Should not throw -- falls back to empty array
      await syncUnsyncedCredentialsToIronClaw(adapter as never);

      expect(adapter.registerCredential).not.toHaveBeenCalled();
      expect(mockServiceCredentialRepository.markSynced).not.toHaveBeenCalled();
    });

    it('does nothing when there are no unsynced credentials', async () => {
      const adapter = makeAdapter();
      mockServiceCredentialRepository.getUnsyncedCredentials.mockResolvedValue([]);

      await syncUnsyncedCredentialsToIronClaw(adapter as never);

      expect(adapter.registerCredential).not.toHaveBeenCalled();
      expect(mockServiceCredentialRepository.markSynced).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // refreshIronClawToolCache
  // =========================================================================
  describe('refreshIronClawToolCache', () => {
    it('discovers tools, persists them, and returns action types', async () => {
      const tools = [
        { name: 'email-send', description: 'Send email', actionTypes: ['send_email'], requiresCredentials: ['google.client_id'] },
        { name: 'calendar-create', description: 'Create event', actionTypes: ['create_event', 'schedule_meeting'], requiresCredentials: [] },
      ];
      const adapter = makeAdapter({
        discoverTools: vi.fn().mockResolvedValue(tools),
      });
      mockIronClawToolRepository.upsertMany.mockResolvedValue([]);

      const result = await refreshIronClawToolCache(adapter as never);

      // Should persist tools to repository
      expect(mockIronClawToolRepository.upsertMany).toHaveBeenCalledWith([
        { toolName: 'email-send', description: 'Send email', actionTypes: ['send_email'], requiresCredentials: ['google.client_id'] },
        { toolName: 'calendar-create', description: 'Create event', actionTypes: ['create_event', 'schedule_meeting'], requiresCredentials: [] },
      ]);

      // Should return flattened action types
      expect(result).toEqual(new Set(['send_email', 'create_event', 'schedule_meeting']));
    });

    it('falls back to cached getSkillSet when discovery fails', async () => {
      const cachedSkills = new Set(['send_email', 'read_email']);
      const adapter = makeAdapter({
        discoverTools: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      mockIronClawToolRepository.getSkillSet.mockResolvedValue(cachedSkills);

      const result = await refreshIronClawToolCache(adapter as never);

      expect(result).toEqual(cachedSkills);
      expect(mockIronClawToolRepository.upsertMany).not.toHaveBeenCalled();
    });

    it('falls back to cached getSkillSet when discovery returns empty tools', async () => {
      const cachedSkills = new Set(['send_email']);
      const adapter = makeAdapter({
        discoverTools: vi.fn().mockResolvedValue([]),
      });
      mockIronClawToolRepository.getSkillSet.mockResolvedValue(cachedSkills);

      const result = await refreshIronClawToolCache(adapter as never);

      expect(result).toEqual(cachedSkills);
      expect(mockIronClawToolRepository.upsertMany).not.toHaveBeenCalled();
    });

    it('returns undefined when no adapter is available and no cached skills exist', async () => {
      // When no adapter is passed, refreshIronClawToolCache calls getIronClawEnhancedAdapter
      // which goes through getExecutionRouter. Set up the router with no ironclaw adapter.
      setupRouterWithAdapter(null);
      mockIronClawToolRepository.getSkillSet.mockRejectedValue(new Error('no table'));

      const result = await refreshIronClawToolCache();

      expect(result).toBeUndefined();
    });

    it('uses cached skills when no adapter is available', async () => {
      const cachedSkills = new Set(['task_create']);
      setupRouterWithAdapter(null);
      mockIronClawToolRepository.getSkillSet.mockResolvedValue(cachedSkills);

      const result = await refreshIronClawToolCache();

      expect(result).toEqual(cachedSkills);
    });

    it('returns undefined when discovery fails and the cache is empty', async () => {
      const adapter = makeAdapter({
        discoverTools: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      mockIronClawToolRepository.getSkillSet.mockResolvedValue(new Set());

      const result = await refreshIronClawToolCache(adapter as never);

      expect(result).toBeUndefined();
    });
  });

  describe('createExecutionRouter', () => {
    it('uses DB execution engine overrides when constructing adapters', async () => {
      const ironclawAdapter = makeAdapter();
      mockRealIronClawAdapter.mockImplementation(function RealIronClawAdapter() {
        return ironclawAdapter;
      });
      mockIsIronClawEnhancedAdapter.mockReturnValue(true);
      mockLoadConfig.mockReturnValue({
        ironclawApiUrl: 'http://env-ironclaw:4000',
        ironclawWebhookSecret: 'env-secret',
        ironclawGatewayToken: '',
        ironclawOwnerId: 'env-owner',
        ironclawDefaultChannel: 'env-channel',
        ironclawPreferChat: false,
        openclawApiUrl: '',
        openclawApiKey: '',
        adapterPluginDir: '',
      });
      mockServiceCredentialRepository.getAsMap.mockImplementation(async (service: string) => {
        if (service === 'ironclaw') {
          return {
            api_url: 'http://db-ironclaw:4000',
            webhook_secret: 'db-secret',
            owner_id: 'db-owner',
            default_channel: 'db-channel',
          };
        }
        return {};
      });
      mockIronClawToolRepository.getSkillSet.mockResolvedValue(new Set(['send_email']));
      mockServiceCredentialRepository.getUnsyncedCredentials.mockResolvedValue([]);

      await createExecutionRouter();

      expect(mockRealIronClawAdapter).toHaveBeenCalledWith(expect.objectContaining({
        apiUrl: 'http://db-ironclaw:4000',
        webhookSecret: 'db-secret',
        ownerId: 'db-owner',
        defaultChannel: 'db-channel',
      }));
      expect(mockAdapterRegistry.register).toHaveBeenCalledWith(
        'ironclaw',
        ironclawAdapter,
        expect.anything(),
        new Set(['send_email']),
      );
    });

    it('delivers OpenClaw credential requirements only to the bound owner', async () => {
      mockLoadConfig.mockReturnValue({
        ironclawApiUrl: '',
        ironclawWebhookSecret: '',
        openclawApiUrl: 'http://localhost:9000',
        openclawApiKey: '',
        adapterPluginDir: '',
      });
      mockCredentialRequirementRepository.register.mockResolvedValue(undefined);

      await createExecutionRouter();

      const options = mockOpenClawAdapter.mock.calls[0]?.[0] as {
        onCredentialNeeded: (requirement: {
          userId: string;
          integration: string;
          integrationLabel: string;
          fields: Array<{ key: string; label: string; secret?: boolean }>;
          skills: string[];
        }) => Promise<void>;
      };
      await options.onCredentialNeeded({
        userId: 'owner-1',
        integration: 'github',
        integrationLabel: 'GitHub',
        fields: [{ key: 'token', label: 'Token', secret: false }],
        skills: ['create_issue'],
      });

      expect(mockCredentialRequirementRepository.register).toHaveBeenCalledWith(
        expect.objectContaining({ fieldKey: 'token', isSecret: true }),
      );

      expect(mockSseManager.emit).toHaveBeenCalledWith(
        'owner-1',
        'credential:needed',
        expect.objectContaining({ integration: 'github' }),
      );
      expect(mockSseManager.emitAll).not.toHaveBeenCalled();
    });

    it('drops account-backed OpenClaw requirements while disabled', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'disabled',
        ironclawApiUrl: '',
        ironclawWebhookSecret: '',
        openclawApiUrl: 'http://localhost:9000',
        openclawApiKey: '',
        adapterPluginDir: '',
      });

      await createExecutionRouter();

      const options = mockOpenClawAdapter.mock.calls[0]?.[0] as {
        onCredentialNeeded: (requirement: {
          userId: string;
          integration: string;
          integrationLabel: string;
          fields: Array<{ key: string; label: string }>;
          skills: string[];
        }) => Promise<void>;
      };
      await options.onCredentialNeeded({
        userId: 'owner-1',
        integration: 'mail',
        integrationLabel: 'Peer mail',
        fields: [{ key: 'token', label: 'Token' }],
        skills: ['send_email'],
      });

      expect(mockCredentialRequirementRepository.register).not.toHaveBeenCalled();
      expect(mockSseManager.emit).not.toHaveBeenCalled();
    });

    it.each(['gmail-mcp', 'google-calendar-mcp', 'outlook-mcp', 'azure-mcp'])
    ('drops the stable registry ID %s when supplied as a dynamic integration', async (integration) => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'disabled',
        ironclawApiUrl: '',
        ironclawWebhookSecret: '',
        openclawApiUrl: 'http://localhost:9000',
        openclawApiKey: '',
        adapterPluginDir: '',
      });

      await createExecutionRouter();

      const options = mockOpenClawAdapter.mock.calls[0]?.[0] as {
        onCredentialNeeded: (requirement: {
          userId: string;
          integration: string;
          integrationLabel: string;
          fields: Array<{ key: string; label: string }>;
          skills: string[];
        }) => Promise<void>;
      };
      await options.onCredentialNeeded({
        userId: 'owner-1',
        integration,
        integrationLabel: 'Peer integration',
        fields: [{ key: 'token', label: 'Token' }],
        skills: [],
      });

      expect(mockCredentialRequirementRepository.register).not.toHaveBeenCalled();
      expect(mockSseManager.emit).not.toHaveBeenCalled();
    });

    it('wires the disabled production admission guard for legacy, dynamic, domain, and MCP aliases', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'disabled',
        ironclawApiUrl: '',
        ironclawWebhookSecret: '',
        openclawApiUrl: '',
        openclawApiKey: '',
        adapterPluginDir: '',
      });

      await createExecutionRouter();

      const guard = mockExecutionRouterConstructor.mock.calls.at(-1)?.[2] as
        ((action: {
          actionType: string;
          domain?: string;
          parameters?: Record<string, unknown>;
        }, userId: string) => Promise<{ allowed: boolean }>) | undefined;
      expect(guard).toBeTypeOf('function');

      for (const actionType of [
        'respond_to_event', 'delete_emails', 'read_email', 'search_emails',
        'create_event', 'update_event', 'schedule_meeting', 'calendar.create',
        'calendar_update', 'rsvp_yes', 'get_calendar_events', 'sendEmail',
        'readEmail', 'respondToEvent', 'deleteEmails', 'schedule_focus_block',
        'users.messages.send', 'me.messages.send', 'users.drafts.create',
        'google.drive.files.list',
        'onedrive.files.list', 'sharepoint.sites.get', 'exchange.messages.send',
        'teams.messages.send',
        'gdrive.files.list', 'youtube.videos.upload', 'gcp.compute.instances.list',
        'google.youtube.videos.list',
      ]) {
        await expect(guard?.({ actionType, domain: 'generic' }, 'owner-1'))
          .resolves.toMatchObject({ allowed: false });
      }
      await expect(guard?.({ actionType: 'accept', domain: 'calendar' }, 'owner-1'))
        .resolves.toMatchObject({ allowed: false });
      await expect(guard?.({
        actionType: 'invoke_tool',
        domain: 'developer',
        parameters: { mcpServerId: 'server-1', mcpToolName: 'read_email' },
      }, 'owner-1')).resolves.toMatchObject({ allowed: false });
      await expect(guard?.({ actionType: 'create_issue', domain: 'developer' }, 'owner-1'))
        .resolves.toEqual({ allowed: true });
    });

    it('blocks a provider-bound MCP target with a neutral tool before preparation', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'disabled',
        ironclawApiUrl: '',
        ironclawWebhookSecret: '',
        openclawApiUrl: '',
        openclawApiKey: '',
        adapterPluginDir: '',
      });
      mockMcpServerRepository.getById.mockResolvedValue({
        id: 'server-google-drive',
        user_id: 'owner-1',
        registry_id: 'google-drive-mcp',
        oauth_provider: 'google',
      });

      await createExecutionRouter();
      const guard = mockExecutionRouterConstructor.mock.calls.at(-1)?.[2] as
        ((action: { actionType: string; parameters: Record<string, unknown> }, userId: string) =>
          Promise<{ allowed: boolean }>) | undefined;

      await expect(guard?.({
        actionType: 'invoke_tool',
        parameters: { mcpServerId: 'server-google-drive', mcpToolName: 'read_file' },
      }, 'owner-1')).resolves.toMatchObject({ allowed: false });
      expect(mockMcpServerRepository.listSkillNamesForServer).not.toHaveBeenCalled();
    });

    it.each([
      ['missing server row', null, []],
      ['wrong owner', {
        id: 'server-1', user_id: 'other-user', registry_id: null, oauth_provider: null,
      }, []],
      ['empty inventory', {
        id: 'server-1', user_id: 'owner-1', registry_id: null, oauth_provider: null,
      }, []],
    ])('fails closed for a targeted MCP server with %s', async (_label, server, skills) => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'disabled',
        ironclawApiUrl: '',
        ironclawWebhookSecret: '',
        openclawApiUrl: '',
        openclawApiKey: '',
        adapterPluginDir: '',
      });
      mockMcpServerRepository.getById.mockResolvedValue(server);
      mockMcpServerRepository.listSkillNamesForServer.mockResolvedValue(skills);

      await createExecutionRouter();
      const guard = mockExecutionRouterConstructor.mock.calls.at(-1)?.[2] as
        ((action: { actionType: string; parameters: Record<string, unknown> }, userId: string) =>
          Promise<{ allowed: boolean }>) | undefined;

      await expect(guard?.({
        actionType: 'invoke_tool',
        parameters: { mcpServerId: 'server-1', mcpToolName: 'search' },
      }, 'owner-1')).resolves.toMatchObject({ allowed: false });
    });

    it('preserves exact experimental MCP admission without consulting persisted inventory', async () => {
      mockLoadConfig.mockReturnValue({
        googleConnectionMode: 'experimental',
        ironclawApiUrl: '',
        ironclawWebhookSecret: '',
        openclawApiUrl: '',
        openclawApiKey: '',
        adapterPluginDir: '',
      });

      await createExecutionRouter();
      const guard = mockExecutionRouterConstructor.mock.calls.at(-1)?.[2] as
        ((action: { actionType: string; parameters: Record<string, unknown> }, userId: string) =>
          Promise<{ allowed: boolean }>) | undefined;

      await expect(guard?.({
        actionType: 'invoke_tool',
        parameters: { mcpServerId: 'server-1', mcpToolName: 'read_file' },
      }, 'owner-1')).resolves.toEqual({ allowed: true });
      expect(mockMcpServerRepository.getById).not.toHaveBeenCalled();
      expect(mockMcpServerRepository.listSkillNamesForServer).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // syncCredentialToIronClaw
  // =========================================================================
  describe('syncCredentialToIronClaw', () => {
    it('rejects Google before resolving or calling an adapter', async () => {
      const adapter = makeAdapter();
      setupRouterWithAdapter(adapter);

      const result = await syncCredentialToIronClaw('google', 'client_secret', 'my-secret');

      expect(result).toBe(false);
      expect(adapter.registerCredential).not.toHaveBeenCalled();
      expect(mockServiceCredentialRepository.markSynced).not.toHaveBeenCalled();
    });

    it.each([
      'openclaw:gmail', 'openclaw:google_calendar', 'google:calendar',
      'microsoft', 'openclaw:outlook', 'openclaw:microsoft_graph', 'azure-mcp',
    ])
      ('rejects the alias %s before resolving or calling an adapter', async (service) => {
        const adapter = makeAdapter();
        setupRouterWithAdapter(adapter);

        const result = await syncCredentialToIronClaw(service, 'token', 'my-secret');

        expect(result).toBe(false);
        expect(adapter.registerCredential).not.toHaveBeenCalled();
        expect(mockServiceCredentialRepository.markSynced).not.toHaveBeenCalled();
      });

    it('rejects a skill-shaped dynamic service before resolving the adapter', async () => {
      const adapter = makeAdapter();
      setupRouterWithAdapter(adapter);
      mockCredentialRequirementRepository.getAllGrouped.mockResolvedValue(new Map([
        ['custom:mail', { adapter: 'custom', fields: [{ skills: ['send_email'] }] }],
      ]));

      const result = await syncCredentialToIronClaw('custom:mail', 'token', 'my-secret');

      expect(result).toBe(false);
      expect(adapter.registerCredential).not.toHaveBeenCalled();
      expect(mockServiceCredentialRepository.markSynced).not.toHaveBeenCalled();
    });

    it('returns false when no adapter is available', async () => {
      setupRouterWithAdapter(null);

      const result = await syncCredentialToIronClaw('github', 'token', 'my-secret');

      expect(result).toBe(false);
    });

    it('returns true on successful registration and marks synced', async () => {
      const adapter = makeAdapter();
      setupRouterWithAdapter(adapter);
      mockServiceCredentialRepository.markSynced.mockResolvedValue(null);

      const result = await syncCredentialToIronClaw('github', 'token', 'my-secret');

      expect(result).toBe(true);
      expect(adapter.registerCredential).toHaveBeenCalledWith('github.token', 'my-secret');
      expect(mockServiceCredentialRepository.markSynced).toHaveBeenCalledWith('github', 'token');
    });

    it('returns false when registerCredential throws', async () => {
      const adapter = makeAdapter({
        registerCredential: vi.fn().mockRejectedValue(new Error('adapter offline')),
      });
      setupRouterWithAdapter(adapter);

      const result = await syncCredentialToIronClaw('github', 'token', 'my-secret');

      expect(result).toBe(false);
      expect(mockServiceCredentialRepository.markSynced).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // revokeCredentialFromIronClaw
  // =========================================================================
  describe('revokeCredentialFromIronClaw', () => {
    it('rejects Google before resolving or calling an adapter', async () => {
      const adapter = makeAdapter();
      setupRouterWithAdapter(adapter);

      const result = await revokeCredentialFromIronClaw('google', 'client_secret');

      expect(result).toBe(false);
      expect(adapter.revokeCredential).not.toHaveBeenCalled();
    });

    it.each(['microsoft', 'outlook', 'openclaw:microsoft_graph'])
    ('rejects account provider %s before resolving or calling an adapter', async (service) => {
      const adapter = makeAdapter();
      setupRouterWithAdapter(adapter);

      const result = await revokeCredentialFromIronClaw(service, 'client_secret');

      expect(result).toBe(false);
      expect(adapter.revokeCredential).not.toHaveBeenCalled();
    });

    it('returns true on successful revocation', async () => {
      const adapter = makeAdapter();
      setupRouterWithAdapter(adapter);

      const result = await revokeCredentialFromIronClaw('github', 'token');

      expect(result).toBe(true);
      expect(adapter.revokeCredential).toHaveBeenCalledWith('github.token');
    });

    it('returns false when revokeCredential throws', async () => {
      const adapter = makeAdapter({
        revokeCredential: vi.fn().mockRejectedValue(new Error('adapter offline')),
      });
      setupRouterWithAdapter(adapter);

      const result = await revokeCredentialFromIronClaw('github', 'token');

      expect(result).toBe(false);
    });
  });
});
