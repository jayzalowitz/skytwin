/**
 * Tests for POST /api/assistant/install-suggestion — issue #322.
 *
 * Coverage:
 *   1. Missing userId → 400
 *   2. Missing/empty userMessage or assistantReply → 400
 *   3. No LLM configured → { intentDetected: false, reason: 'no_llm_configured' }
 *   4. LLM happy path → returns intentDetected: true + suggestions array
 *      (snake_case → camelCase boundary translation)
 *   5. Belt-and-suspenders: filters out any installed-capability suggestion
 *      that leaks through the prompt
 *   6. Deterministic fallback → reports provider_unavailable to browser
 *   7. runPrompt throws → fail-soft with prompt_failed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Hoist mocks ──────────────────────────────────────────────────────────────

const { mockRunPrompt, mockRegistryGetAll, mockLoadConfig } = vi.hoisted(() => ({
  mockRunPrompt: vi.fn(),
  mockRegistryGetAll: vi.fn(),
  mockLoadConfig: vi.fn(),
}));

vi.mock('@skytwin/config', () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock('@skytwin/policy-prompts', () => ({
  runPrompt: mockRunPrompt,
}));

vi.mock('@skytwin/llm-client', async () => {
  const actual = await vi.importActual<typeof import('@skytwin/llm-client')>(
    '@skytwin/llm-client',
  );
  return {
    ...actual,
    LlmClient: Object.assign(vi.fn(function LlmClient() {
      return {};
    }), { forReasoningMode: vi.fn(() => ({})) }),
  };
});

const {
  mockMcpServerRepository,
  mockAiProviderRepository,
} = vi.hoisted(() => ({
  mockMcpServerRepository: { listForUser: vi.fn() },
  mockAiProviderRepository: {
    getEnabledForUser: vi.fn(),
    getReasoningSnapshotForUser: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepository,
  aiProviderRepository: mockAiProviderRepository,
  reasoningModeRepository: {
    getOrCreateForUser: vi.fn().mockResolvedValue({
      mode: 'bring_your_own_provider', requires_confirmation: false,
    }),
  },
  // Other repository imports in assistant.ts — stubbed so the module loads.
  approvalRepository: {},
  assistantRepository: {},
  emailLabelRepository: {},
  mempalaceRepository: {},
  userRepository: { findById: vi.fn() },
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  decisionRepositoryAdapter: {},
  explanationRepositoryAdapter: {},
  policyRepositoryAdapter: {},
}));

vi.mock('@skytwin/registry-client', () => ({
  RegistryClient: vi.fn(function RegistryClient() {
    return {
      getAll: mockRegistryGetAll,
    };
  }),
}));

vi.mock('@skytwin/assistant', () => ({
  AssistantService: vi.fn(),
  ContextBuilder: vi.fn(),
}));
vi.mock('@skytwin/twin-model', () => ({ TwinService: vi.fn() }));
vi.mock('@skytwin/decision-engine', () => ({ DecisionMaker: vi.fn() }));
vi.mock('@skytwin/policy-engine', () => ({ PolicyEvaluator: vi.fn() }));
vi.mock('@skytwin/explanations', () => ({ ExplanationGenerator: vi.fn() }));
vi.mock('../sse.js', () => ({ sseManager: { emit: vi.fn() } }));
vi.mock('../validators/assistant-message.js', () => ({
  validateAssistantMessage: vi.fn(),
}));
vi.mock('../memory-setup.js', () => ({ getMemoryPortForUser: vi.fn() }));

import { createAssistantRouter } from '../routes/assistant.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantRouter());
  return app;
}

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
      if (body !== undefined) options.body = JSON.stringify(body);
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

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({ googleConnectionMode: 'experimental' });
  mockRegistryGetAll.mockResolvedValue([
    { id: 'linear-mcp', displayName: 'Linear', description: 'Manage Linear issues', oauthProvider: null },
    { id: '@modelcontextprotocol/server-github', displayName: 'GitHub', description: 'GitHub PRs and issues', oauthProvider: 'github' },
    { id: '@modelcontextprotocol/server-slack', displayName: 'Slack', description: 'Send Slack messages', oauthProvider: null },
  ]);
  mockAiProviderRepository.getReasoningSnapshotForUser.mockImplementation(async () => {
    const providers = await mockAiProviderRepository.getEnabledForUser();
    return {
      providers: providers.map((provider: { enabled?: boolean }) => ({
        ...provider,
        enabled: provider.enabled ?? true,
      })),
      reasoningMode: {
        mode: 'bring_your_own_provider', requires_confirmation: false,
      },
    };
  });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/assistant/install-suggestion', () => {
  it('returns 400 when userId is missing', async () => {
    const res = await request(buildApp(), 'POST', '/api/assistant/install-suggestion', {
      userMessage: 'hi',
      assistantReply: 'hello',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when userMessage is empty', async () => {
    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      { userMessage: '', assistantReply: 'something' },
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when assistantReply is missing', async () => {
    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      { userMessage: 'something' },
    );
    expect(res.status).toBe(400);
  });

  it('returns no_llm_configured when the user has no providers (browser falls back to heuristic)', async () => {
    mockAiProviderRepository.getEnabledForUser.mockResolvedValue([]);

    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      {
        userMessage: 'File a Linear issue',
        assistantReply: "I don't have access to Linear",
      },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      intentDetected: false,
      suggestions: [],
      reason: 'no_llm_configured',
    });
    // runPrompt must NOT have been invoked — no LLM, no prompt run
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('returns intentDetected + suggestions on LLM happy path (snake_case → camelCase boundary)', async () => {
    mockAiProviderRepository.getEnabledForUser.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { registry_id: 'gmail-mcp', display_name: 'Gmail' },
    ]);
    mockRunPrompt.mockResolvedValue({
      output: {
        intent_detected: true,
        suggestions: [
          {
            id: 'linear-mcp',
            name: 'Linear',
            reason: 'Connect Linear to file the issue the user asked about.',
            confidence: 0.92,
          },
        ],
      },
      fellBackToDeterministic: false,
    });

    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      {
        userMessage: 'File a Linear issue for that staging crash',
        assistantReply: "I don't have Linear access yet.",
      },
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      intentDetected: boolean;
      suggestions: Array<{
        registryId: string;
        displayName: string;
        reason: string;
        confidence: number;
      }>;
    };
    expect(body.intentDetected).toBe(true);
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]).toEqual({
      registryId: 'linear-mcp',
      displayName: 'Linear',
      reason: 'Connect Linear to file the issue the user asked about.',
      confidence: 0.92,
    });
  });

  it('filters out any suggestion whose registry id is already installed (belt-and-suspenders)', async () => {
    mockAiProviderRepository.getEnabledForUser.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { registry_id: 'linear-mcp', display_name: 'Linear', status: 'active' },
    ]);
    // Simulate the LLM violating its constraint and suggesting an
    // already-installed capability. The route must drop it.
    mockRunPrompt.mockResolvedValue({
      output: {
        intent_detected: true,
        suggestions: [
          {
            id: 'linear-mcp',
            name: 'Linear',
            reason: 'connect Linear (already installed — should be filtered)',
            confidence: 0.95,
          },
          {
            id: '@modelcontextprotocol/server-github',
            name: 'GitHub',
            reason: 'or GitHub for code-side tracking',
            confidence: 0.8,
          },
        ],
      },
      fellBackToDeterministic: false,
    });

    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      { userMessage: 'File a Linear issue', assistantReply: 'I cannot do that' },
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      suggestions: Array<{ registryId: string }>;
    };
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]!.registryId).toBe('@modelcontextprotocol/server-github');
  });

  it('removes stale and curated Google capabilities from prompt inputs and final output when disabled', async () => {
    mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
    mockAiProviderRepository.getEnabledForUser.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    mockMcpServerRepository.listForUser.mockResolvedValue([
      {
        registry_id: 'custom-drive',
        display_name: 'Drive alias',
        oauth_provider: 'google',
        status: 'active',
      },
      {
        registry_id: '@modelcontextprotocol/server-slack',
        display_name: 'Slack',
        oauth_provider: null,
        status: 'paused',
      },
    ]);
    mockRegistryGetAll.mockResolvedValue([
      { id: 'gmail-mcp', displayName: 'Gmail', description: 'Mail', oauthProvider: 'google' },
      { id: 'linear-mcp', displayName: 'Linear', description: 'Issues', oauthProvider: null },
    ]);
    mockRunPrompt.mockResolvedValue({
      output: {
        intent_detected: true,
        suggestions: [
          { id: 'gmail-mcp', name: 'Gmail', reason: 'Use mail', confidence: 0.95 },
          { id: 'linear-mcp', name: 'Linear', reason: 'Use issues', confidence: 0.9 },
        ],
      },
      fellBackToDeterministic: false,
    });

    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      { userMessage: 'Connect a tool', assistantReply: 'I need a capability' },
    );

    expect(res.status).toBe(200);
    const promptCall = mockRunPrompt.mock.calls[0]?.[0] as {
      inputs: {
        installed_capabilities: Array<{ id: string }>;
        available_capabilities: Array<{ id: string }>;
      };
    };
    expect(promptCall.inputs.installed_capabilities.map((entry) => entry.id))
      .toEqual(['@modelcontextprotocol/server-slack']);
    expect(promptCall.inputs.available_capabilities.map((entry) => entry.id)).toEqual(['linear-mcp']);
    expect((res.body as { suggestions: Array<{ registryId: string }> }).suggestions)
      .toEqual([expect.objectContaining({ registryId: 'linear-mcp' })]);
  });

  it('preserves Google prompt candidates behind the exact experimental opt-in', async () => {
    mockLoadConfig.mockReturnValue({ googleConnectionMode: 'experimental' });
    mockAiProviderRepository.getEnabledForUser.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
    mockRegistryGetAll.mockResolvedValue([
      { id: 'gmail-mcp', displayName: 'Gmail', description: 'Mail', oauthProvider: 'google' },
    ]);
    mockRunPrompt.mockResolvedValue({
      output: {
        intent_detected: true,
        suggestions: [
          { id: 'gmail-mcp', name: 'Gmail', reason: 'Use mail', confidence: 0.95 },
        ],
      },
      fellBackToDeterministic: false,
    });

    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      { userMessage: 'Connect mail', assistantReply: 'I need a capability' },
    );

    expect(res.status).toBe(200);
    expect((res.body as { suggestions: Array<{ registryId: string }> }).suggestions)
      .toEqual([expect.objectContaining({ registryId: 'gmail-mcp' })]);
  });

  it('treats uninstalled / failed / discovered statuses as NOT installed (so they can be re-suggested)', async () => {
    mockAiProviderRepository.getEnabledForUser.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    // User has Linear listed in mcp_servers but with status='uninstalled' —
    // they explicitly removed it. The endpoint should NOT count this as
    // installed, so the prompt CAN suggest re-installing Linear.
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { registry_id: 'linear-mcp', display_name: 'Linear', status: 'uninstalled' },
      { registry_id: 'gmail-mcp', display_name: 'Gmail', status: 'failed' },
      { registry_id: '@modelcontextprotocol/server-slack', display_name: 'Slack', status: 'paused' },
    ]);
    mockRunPrompt.mockResolvedValue({
      output: {
        intent_detected: true,
        suggestions: [
          {
            id: 'linear-mcp',
            name: 'Linear',
            reason: 'Re-install Linear to file the issue.',
            confidence: 0.9,
          },
        ],
      },
      fellBackToDeterministic: false,
    });

    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      { userMessage: 'File a Linear issue', assistantReply: 'I cannot' },
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      suggestions: Array<{ registryId: string }>;
    };
    // Linear's status='uninstalled' so it's NOT treated as installed,
    // so the re-install suggestion lands.
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]!.registryId).toBe('linear-mcp');
  });

  it('drops hallucinated suggestion ids that do not appear in the registry', async () => {
    mockAiProviderRepository.getEnabledForUser.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
    // LLM returns a mix: one real registry id, one hallucinated id that
    // doesn't exist in the registry candidate set.
    mockRunPrompt.mockResolvedValue({
      output: {
        intent_detected: true,
        suggestions: [
          {
            id: 'linear-mcp',
            name: 'Linear',
            reason: 'file an issue',
            confidence: 0.9,
          },
          {
            id: 'nonexistent-fake-mcp',
            name: 'Fake',
            reason: 'this was hallucinated',
            confidence: 0.95,
          },
        ],
      },
      fellBackToDeterministic: false,
    });

    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      { userMessage: 'do a thing', assistantReply: 'I cannot' },
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      suggestions: Array<{ registryId: string }>;
    };
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]!.registryId).toBe('linear-mcp');
  });

  it('returns 413 when userMessage or assistantReply exceeds 16KB', async () => {
    const giant = 'a'.repeat(16 * 1024 + 1);
    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      { userMessage: giant, assistantReply: 'ok' },
    );
    expect(res.status).toBe(413);
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('reports provider_unavailable when the prompt falls back to deterministic', async () => {
    mockAiProviderRepository.getEnabledForUser.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
    mockRunPrompt.mockResolvedValue({
      output: { intent_detected: false, suggestions: [], reason: 'no_llm_configured' },
      fellBackToDeterministic: true,
    });

    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      { userMessage: 'do a thing', assistantReply: 'I cannot' },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      intentDetected: false,
      suggestions: [],
      reason: 'provider_unavailable',
    });
  });

  it('fails soft to prompt_failed when runPrompt throws (browser heuristic covers UX)', async () => {
    mockAiProviderRepository.getEnabledForUser.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
    mockRunPrompt.mockRejectedValue(new Error('upstream timeout'));

    const res = await request(
      buildApp(),
      'POST',
      `/api/assistant/install-suggestion?userId=${USER_ID}`,
      { userMessage: 'do a thing', assistantReply: 'I cannot' },
    );

    expect(res.status).toBe(200);
    const body = res.body as { reason: string; suggestions: unknown[] };
    expect(body.reason).toBe('prompt_failed');
    expect(body.suggestions).toEqual([]);
  });
});
