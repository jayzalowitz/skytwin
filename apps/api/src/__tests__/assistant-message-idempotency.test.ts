import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REQUEST_ID = '11111111-2222-3333-4444-555555555555';
const THREAD_ID = '22222222-2222-3333-4444-555555555555';
const USER_MESSAGE = {
  id: '33333333-2222-3333-4444-555555555555',
  threadId: THREAD_ID,
  role: 'user' as const,
  content: 'archive that email',
  createdAt: new Date(),
  metadata: null,
  clientRequestId: REQUEST_ID,
};
const ASSISTANT_MESSAGE = {
  id: '44444444-2222-3333-4444-555555555555',
  threadId: THREAD_ID,
  role: 'assistant' as const,
  content: 'Approval required.',
  createdAt: new Date(),
  metadata: { intentRoute: { kind: 'requires-approval', approvalRequestId: 'approval-1' } },
};

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  createThread: vi.fn(),
  createThreadWithUserMessage: vi.fn(),
  appendUser: vi.fn(),
  getThread: vi.fn(),
  appendMessage: vi.fn(),
  findAssistant: vi.fn(),
  appendAssistant: vi.fn(),
  claimStale: vi.fn(),
  routeIntent: vi.fn(),
  reply: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  aiProviderRepository: { getEnabledForUser: vi.fn().mockResolvedValue([
    { provider: 'openai', api_key: 'key', model: 'model', base_url: null },
  ]) },
  assistantRepository: {
    findUserMessageByRequestId: mocks.findUser,
    createThread: mocks.createThread,
    createThreadWithUserMessage: mocks.createThreadWithUserMessage,
    appendOrGetUserMessage: mocks.appendUser,
    getThread: mocks.getThread,
    appendMessage: mocks.appendMessage,
    findAssistantMessageByRequestId: mocks.findAssistant,
    appendOrGetAssistantMessage: mocks.appendAssistant,
    claimStaleUserMessageRequest: mocks.claimStale,
  },
  approvalRepository: {}, emailLabelRepository: {}, mcpServerRepository: {},
  mempalaceRepository: {}, userRepository: { findById: vi.fn() },
  TwinRepositoryAdapter: vi.fn(), PatternRepositoryAdapter: vi.fn(),
  decisionRepositoryAdapter: {}, explanationRepositoryAdapter: {}, policyRepositoryAdapter: {},
  preEffectBarrierRepository: {},
}));
vi.mock('@skytwin/assistant', () => ({
  AssistantService: vi.fn(function AssistantService() {
    return { routeIntent: mocks.routeIntent, reply: mocks.reply };
  }),
  ContextBuilder: vi.fn(),
  detectIntent: vi.fn(() => ({ domain: 'email' })),
}));
vi.mock('@skytwin/llm-client', () => ({
  LlmClient: vi.fn(),
  AllProvidersFailedError: class AllProvidersFailedError extends Error {},
}));
vi.mock('@skytwin/twin-model', () => ({ TwinService: vi.fn() }));
vi.mock('@skytwin/decision-engine', () => ({ DecisionMaker: vi.fn() }));
vi.mock('@skytwin/policy-engine', () => ({ PolicyEvaluator: vi.fn() }));
vi.mock('@skytwin/explanations', () => ({ ExplanationGenerator: vi.fn() }));
vi.mock('@skytwin/core', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@skytwin/policy-prompts', () => ({ runPrompt: vi.fn() }));
vi.mock('@skytwin/registry-client', () => ({ RegistryClient: vi.fn() }));
vi.mock('../memory-setup.js', () => ({ getMemoryPortForUser: vi.fn() }));
vi.mock('../lib/user-llm-client.js', () => ({
  resolveUserLlmClient: vi.fn().mockResolvedValue({
    state: 'ready', client: { hasProviders: true }, reason: 'test provider',
  }),
}));
vi.mock('../sse.js', () => ({ sseManager: { emit: vi.fn() } }));

import { createAssistantRouter } from '../routes/assistant.js';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantRouter());
  return app;
}

async function post(app: Express): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('listen failed'));
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/assistant/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: USER_ID, content: USER_MESSAGE.content, requestId: REQUEST_ID }),
        });
        resolve({ status: response.status, body: await response.json() as Record<string, unknown> });
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

describe('POST /api/assistant/messages idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let persistedAssistant = false;
    mocks.findUser.mockResolvedValueOnce(null).mockResolvedValue(USER_MESSAGE);
    mocks.createThread.mockResolvedValue({ id: THREAD_ID });
    mocks.createThreadWithUserMessage.mockResolvedValue({
      thread: { id: THREAD_ID }, message: USER_MESSAGE, created: true,
    });
    mocks.appendUser
      .mockResolvedValue({ message: USER_MESSAGE, created: false });
    mocks.getThread.mockImplementation(async () => ({
      thread: { id: THREAD_ID },
      messages: persistedAssistant ? [USER_MESSAGE, ASSISTANT_MESSAGE] : [USER_MESSAGE],
    }));
    mocks.appendMessage.mockImplementation(async () => {
      persistedAssistant = true;
      return ASSISTANT_MESSAGE;
    });
    mocks.findAssistant.mockImplementation(async () => (
      persistedAssistant ? ASSISTANT_MESSAGE : null
    ));
    mocks.appendAssistant.mockImplementation(async () => {
      persistedAssistant = true;
      return ASSISTANT_MESSAGE;
    });
    mocks.routeIntent.mockResolvedValue({
      intent: { domain: 'email' },
      outcome: { kind: 'requires-approval', approvalRequestId: 'approval-1' },
    });
    mocks.reply.mockResolvedValue({ content: 'Hello.', metadata: { provider: 'test' } });
    mocks.claimStale.mockResolvedValue(false);
  });

  it('reuses one user message, action idempotency key, and approval bubble across two requests', async () => {
    const app = buildApp();
    const first = await post(app);
    const second = await post(app);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.createThread).not.toHaveBeenCalled();
    expect(mocks.createThreadWithUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.appendUser).not.toHaveBeenCalled();
    expect(mocks.appendAssistant).toHaveBeenCalledTimes(1);
    expect(mocks.appendMessage).not.toHaveBeenCalled();
    expect(mocks.routeIntent).toHaveBeenCalledTimes(1);
    expect(mocks.routeIntent.mock.calls.map((call) => call[2]?.idempotencyKey))
      .toEqual([USER_MESSAGE.id]);
  });

  it('returns typed 202 for a concurrent duplicate while the owner request is in progress', async () => {
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { ownerEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const outcome = {
      intent: { domain: 'email' },
      outcome: { kind: 'requires-approval', approvalRequestId: 'approval-1' },
    };
    mocks.routeIntent.mockImplementationOnce(async () => {
      ownerEntered();
      await release;
      return outcome;
    });

    const app = buildApp();
    const ownerRequest = post(app);
    await entered;
    const duplicate = await post(app);
    releaseOwner();
    const owner = await ownerRequest;

    expect(owner.status).toBe(200);
    expect(duplicate.status).toBe(202);
    expect(duplicate.body).toMatchObject({
      status: 'in_progress', code: 'assistant_request_in_progress',
    });
    expect(mocks.routeIntent).toHaveBeenCalledTimes(1);
  });

  it('adopts a stale crashed request and completes it with the same durable key', async () => {
    mocks.findUser.mockReset().mockResolvedValue(USER_MESSAGE);
    mocks.createThreadWithUserMessage.mockReset();
    mocks.claimStale.mockResolvedValue(true);

    const response = await post(buildApp());

    expect(response.status).toBe(200);
    expect(mocks.claimStale).toHaveBeenCalledWith(USER_ID, REQUEST_ID);
    expect(mocks.routeIntent).toHaveBeenCalledTimes(1);
    expect(mocks.routeIntent.mock.calls[0]?.[2]?.idempotencyKey).toBe(USER_MESSAGE.id);
    expect(mocks.appendAssistant).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent new-thread ordinary chat after a recoverable commit response', async () => {
    mocks.routeIntent.mockResolvedValue(null);
    mocks.findUser.mockReset().mockResolvedValueOnce(null).mockResolvedValue(USER_MESSAGE);

    const responses = await Promise.all([post(buildApp()), post(buildApp())]);

    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => response.status === 200 || response.status === 202)).toBe(true);
    expect(mocks.createThreadWithUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.createThread).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.appendAssistant).toHaveBeenCalledTimes(1);
    expect(mocks.appendMessage).not.toHaveBeenCalled();
  });
});
