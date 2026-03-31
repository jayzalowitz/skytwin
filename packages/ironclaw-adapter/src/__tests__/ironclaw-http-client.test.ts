import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { IronClawHttpClient, type IronClawMessage } from '../ironclaw-http-client.js';

function makeClient(overrides: Record<string, unknown> = {}): IronClawHttpClient {
  return new IronClawHttpClient({
    apiUrl: 'http://localhost:4000',
    webhookSecret: 'test-secret',
    ownerId: 'test-owner',
    maxRetries: 0,
    ...overrides,
  });
}

function makeMessage(overrides: Partial<IronClawMessage> = {}): IronClawMessage {
  return {
    channel: 'skytwin',
    user_id: 'user_1',
    owner_id: 'test-owner',
    content: 'Test message',
    attachments: [],
    metadata: { skytwin: true },
    ...overrides,
  };
}

/** Extract the URL and init from a fetch mock call */
function getFetchCall(mock: ReturnType<typeof vi.fn>, index: number): [string, RequestInit] {
  const call = mock.mock.calls[index] as [string | URL | Request, RequestInit | undefined];
  return [String(call[0]), call[1] ?? {}];
}

describe('IronClawHttpClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  describe('HMAC-SHA256 authentication', () => {
    it('signs requests with the correct HMAC-SHA256 signature', async () => {
      const client = makeClient();

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ content: 'ok', attachments: [], metadata: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const message = makeMessage();
      await client.sendMessage(message);

      const [, options] = getFetchCall(fetchMock, 0);
      const body = options.body as string;
      const headers = options.headers as Record<string, string>;

      // Compute expected signature
      const expected = createHmac('sha256', 'test-secret').update(body).digest('hex');
      expect(headers['X-Signature-256']).toBe(`sha256=${expected}`);
    });
  });

  describe('sendMessage', () => {
    it('posts to /webhook with correct headers', async () => {
      const client = makeClient();

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ content: 'ok', attachments: [], metadata: {} }), {
          status: 200,
        }),
      );

      await client.sendMessage(makeMessage());

      const [url, options] = getFetchCall(fetchMock, 0);
      expect(url).toBe('http://localhost:4000/webhook');
      expect(options.method).toBe('POST');

      const headers = options.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-IronClaw-Channel']).toBe('skytwin');
    });

    it('throws on 4xx client errors without retrying', async () => {
      const client = makeClient({ maxRetries: 2 });

      fetchMock.mockResolvedValue(
        new Response('Bad Request', { status: 400 }),
      );

      await expect(client.sendMessage(makeMessage())).rejects.toThrow('400');
      // Should only call once (no retries for 4xx)
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries on 5xx server errors', async () => {
      const client = makeClient({ maxRetries: 2 });

      fetchMock
        .mockResolvedValueOnce(new Response('Error', { status: 500 }))
        .mockResolvedValueOnce(new Response('Error', { status: 500 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ content: 'ok', attachments: [], metadata: {} }), {
            status: 200,
          }),
        );

      const result = await client.sendMessage(makeMessage());
      expect(result.content).toBe('ok');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries on 429 rate limit', async () => {
      const client = makeClient({ maxRetries: 1 });

      fetchMock
        .mockResolvedValueOnce(new Response('Rate Limited', { status: 429 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ content: 'ok', attachments: [], metadata: {} }), {
            status: 200,
          }),
        );

      const result = await client.sendMessage(makeMessage());
      expect(result.content).toBe('ok');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('healthCheck', () => {
    it('calls GET /health', async () => {
      const client = makeClient();

      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const result = await client.healthCheck();
      expect(result.healthy).toBe(true);

      const [url, options] = getFetchCall(fetchMock, 0);
      expect(url).toBe('http://localhost:4000/health');
      expect(options.method).toBe('GET');
    });

    it('returns unhealthy on fetch error', async () => {
      const client = makeClient();

      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await client.healthCheck();
      expect(result.healthy).toBe(false);
    });
  });

  describe('circuit breaker', () => {
    it('opens after threshold failures', async () => {
      const client = makeClient({
        maxRetries: 0,
        circuitBreakerThreshold: 3,
        circuitBreakerWindowMs: 60_000,
      });

      fetchMock.mockResolvedValue(new Response('Bad', { status: 400 }));

      // Trigger 3 failures
      for (let i = 0; i < 3; i++) {
        await client.sendMessage(makeMessage()).catch(() => { /* expected */ });
      }

      expect(client.isCircuitOpen).toBe(true);

      // Next call should fail immediately with circuit breaker error
      await expect(client.sendMessage(makeMessage())).rejects.toThrow('circuit breaker');
    });

    it('resets after successful health check', async () => {
      const client = makeClient({
        maxRetries: 0,
        circuitBreakerThreshold: 2,
        circuitBreakerWindowMs: 60_000,
      });

      fetchMock.mockResolvedValue(new Response('Bad', { status: 400 }));

      // Trigger failures to open the breaker
      await client.sendMessage(makeMessage()).catch(() => { /* expected */ });
      await client.sendMessage(makeMessage()).catch(() => { /* expected */ });
      expect(client.isCircuitOpen).toBe(true);

      // Health check succeeds → resets breaker
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));
      const health = await client.healthCheck();
      expect(health.healthy).toBe(true);
      expect(client.isCircuitOpen).toBe(false);
    });
  });

  describe('parseExecutionResult', () => {
    it('parses completed response with structured metadata', () => {
      const client = makeClient();
      const startedAt = new Date();

      const result = client.parseExecutionResult('plan_1', {
        content: 'Email archived',
        attachments: [],
        metadata: {
          status: 'completed',
          outputs: { messageId: 'msg_123' },
        },
      }, startedAt);

      expect(result.planId).toBe('plan_1');
      expect(result.status).toBe('completed');
      expect(result.startedAt).toBe(startedAt);
      expect(result.completedAt).toBeDefined();
      expect(result.output!['messageId']).toBe('msg_123');
      expect(result.output!['ironclawResponse']).toBe('Email archived');
    });

    it('parses failed response with error', () => {
      const client = makeClient();

      const result = client.parseExecutionResult('plan_1', {
        content: 'Something went wrong',
        attachments: [],
        metadata: {
          status: 'failed',
          error: 'Permission denied',
        },
      }, new Date());

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Permission denied');
    });

    it('infers status from content when metadata has no status', () => {
      const client = makeClient();

      const successResult = client.parseExecutionResult('plan_1', {
        content: 'All good',
        attachments: [],
        metadata: {},
      }, new Date());
      expect(successResult.status).toBe('completed');

      const failResult = client.parseExecutionResult('plan_2', {
        content: 'Error occurred during processing',
        attachments: [],
        metadata: {},
      }, new Date());
      expect(failResult.status).toBe('failed');
    });
  });

  describe('parseRollbackResult', () => {
    it('parses successful rollback', () => {
      const client = makeClient();

      const result = client.parseRollbackResult({
        content: 'Rollback completed',
        attachments: [],
        metadata: { status: 'completed' },
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Rollback completed');
    });

    it('parses failed rollback', () => {
      const client = makeClient();

      const result = client.parseRollbackResult({
        content: 'Cannot undo',
        attachments: [],
        metadata: { status: 'failed', error: 'Irreversible action' },
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('Irreversible action');
    });
  });
});
