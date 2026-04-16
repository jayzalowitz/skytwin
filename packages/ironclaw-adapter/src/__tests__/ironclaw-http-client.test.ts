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

    it('resets health breaker after successful health check but not other endpoints', async () => {
      const client = makeClient({
        maxRetries: 0,
        circuitBreakerThreshold: 2,
        circuitBreakerWindowMs: 60_000,
      });

      fetchMock.mockResolvedValue(new Response('Bad', { status: 400 }));

      // Trigger failures to open the webhook breaker
      await client.sendMessage(makeMessage()).catch(() => { /* expected */ });
      await client.sendMessage(makeMessage()).catch(() => { /* expected */ });
      expect(client.isCircuitOpenFor('webhook')).toBe(true);

      // Health check succeeds → resets only health breaker, not webhook
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));
      const health = await client.healthCheck();
      expect(health.healthy).toBe(true);
      // Webhook breaker remains open — health endpoint success doesn't prove webhook works
      expect(client.isCircuitOpenFor('webhook')).toBe(true);
      expect(client.isCircuitOpenFor('health')).toBe(false);
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

  describe('registerCredential', () => {
    it('posts to /credentials with bearer auth and returns success', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const result = await client.registerCredential('gmail_oauth', 'token-value-123', { ttlSeconds: 3600 });

      expect(result).toEqual({ success: true });

      const [url, options] = getFetchCall(fetchMock, 0);
      expect(url).toBe('http://localhost:4000/credentials');
      expect(options.method).toBe('POST');

      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-gw-token');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body as string);
      expect(body.name).toBe('gmail_oauth');
      expect(body.value).toBe('token-value-123');
      expect(body.ttl_seconds).toBe(3600);
    });

    it('throws on 4xx error', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401 }),
      );

      await expect(
        client.registerCredential('bad_cred', 'value'),
      ).rejects.toThrow('401');
    });
  });

  describe('revokeCredential', () => {
    it('sends DELETE to /credentials/:name with bearer auth and returns success', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const result = await client.revokeCredential('gmail_oauth');

      expect(result).toEqual({ success: true });

      const [url, options] = getFetchCall(fetchMock, 0);
      expect(url).toBe('http://localhost:4000/credentials/gmail_oauth');
      expect(options.method).toBe('DELETE');

      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-gw-token');
    });
  });

  describe('listCredentials', () => {
    it('parses response when payload is an array', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { name: 'gmail_oauth', configured_at: '2026-01-01T00:00:00Z', expires_at: '2026-02-01T00:00:00Z' },
          { name: 'calendar_key', configuredAt: '2026-03-15T12:00:00Z' },
        ]), { status: 200 }),
      );

      const result = await client.listCredentials();

      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe('gmail_oauth');
      expect(result[0]!.configuredAt).toBe('2026-01-01T00:00:00Z');
      expect(result[0]!.expiresAt).toBe('2026-02-01T00:00:00Z');
      expect(result[1]!.name).toBe('calendar_key');
      expect(result[1]!.configuredAt).toBe('2026-03-15T12:00:00Z');
      expect(result[1]!.expiresAt).toBeUndefined();

      const [url, options] = getFetchCall(fetchMock, 0);
      expect(url).toBe('http://localhost:4000/credentials');
      expect(options.method).toBe('GET');

      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-gw-token');
    });

    it('parses response when payload is { credentials: [...] }', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({
          credentials: [
            { name: 'slack_token', created_at: '2026-04-10T00:00:00Z' },
          ],
        }), { status: 200 }),
      );

      const result = await client.listCredentials();

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('slack_token');
      expect(result[0]!.configuredAt).toBe('2026-04-10T00:00:00Z');
    });
  });

  describe('discoverTools', () => {
    it('parses tool manifests from array response', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          {
            name: 'gmail_archive',
            description: 'Archive Gmail messages',
            action_types: ['archive_email'],
            requires_credentials: ['gmail_oauth'],
          },
          {
            name: 'calendar_create',
            description: 'Create calendar events',
            actionTypes: ['create_event', 'update_event'],
            credentials: ['google_calendar'],
          },
        ]), { status: 200 }),
      );

      const result = await client.discoverTools();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'gmail_archive',
        description: 'Archive Gmail messages',
        actionTypes: ['archive_email'],
        requiresCredentials: ['gmail_oauth'],
      });
      expect(result[1]).toEqual({
        name: 'calendar_create',
        description: 'Create calendar events',
        actionTypes: ['create_event', 'update_event'],
        requiresCredentials: ['google_calendar'],
      });

      const [url, options] = getFetchCall(fetchMock, 0);
      expect(url).toBe('http://localhost:4000/tools');
      expect(options.method).toBe('GET');

      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-gw-token');
    });

    it('parses tool manifests from { tools: [...] } response', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({
          tools: [
            { name: 'slack_post', description: 'Post to Slack', actions: ['send_message'] },
          ],
        }), { status: 200 }),
      );

      const result = await client.discoverTools();

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('slack_post');
      expect(result[0]!.description).toBe('Post to Slack');
      expect(result[0]!.actionTypes).toEqual(['send_message']);
    });
  });

  describe('createRoutine', () => {
    it('posts to /routines and returns the routine ID', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ routineId: 'routine_abc' }), { status: 200 }),
      );

      const result = await client.createRoutine('0 9 * * *', { steps: ['archive'] });

      expect(result).toEqual({ routineId: 'routine_abc' });

      const [url, options] = getFetchCall(fetchMock, 0);
      expect(url).toBe('http://localhost:4000/routines');
      expect(options.method).toBe('POST');

      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-gw-token');

      const body = JSON.parse(options.body as string);
      expect(body.schedule).toBe('0 9 * * *');
      expect(body.plan).toEqual({ steps: ['archive'] });
    });

    it('reads routine_id key if routineId is absent', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ routine_id: 'routine_def' }), { status: 200 }),
      );

      const result = await client.createRoutine('0 9 * * *', { steps: [] });
      expect(result).toEqual({ routineId: 'routine_def' });
    });

    it('reads id key as fallback', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'routine_ghi' }), { status: 200 }),
      );

      const result = await client.createRoutine('0 9 * * *', { steps: [] });
      expect(result).toEqual({ routineId: 'routine_ghi' });
    });

    it('throws if response contains no routine ID', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      );

      await expect(
        client.createRoutine('0 9 * * *', { steps: [] }),
      ).rejects.toThrow('routine ID');
    });
  });

  describe('listRoutines', () => {
    it('returns parsed IronClawRoutine array with user_id query param', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          {
            id: 'routine_1',
            schedule: '0 9 * * *',
            plan_summary: 'Morning email triage',
            last_run_at: '2026-04-15T09:00:00Z',
            next_run_at: '2026-04-16T09:00:00Z',
            enabled: true,
          },
          {
            id: 'routine_2',
            cron: '0 17 * * 5',
            summary: 'Weekly report',
            enabled: false,
          },
        ]), { status: 200 }),
      );

      const result = await client.listRoutines('user_1');

      expect(result).toHaveLength(2);

      expect(result[0]!.id).toBe('routine_1');
      expect(result[0]!.schedule).toBe('0 9 * * *');
      expect(result[0]!.planSummary).toBe('Morning email triage');
      expect(result[0]!.lastRunAt).toEqual(new Date('2026-04-15T09:00:00Z'));
      expect(result[0]!.nextRunAt).toEqual(new Date('2026-04-16T09:00:00Z'));
      expect(result[0]!.enabled).toBe(true);

      expect(result[1]!.id).toBe('routine_2');
      expect(result[1]!.schedule).toBe('0 17 * * 5');
      expect(result[1]!.planSummary).toBe('Weekly report');
      expect(result[1]!.lastRunAt).toBeUndefined();
      expect(result[1]!.nextRunAt).toBeUndefined();
      expect(result[1]!.enabled).toBe(false);

      const [url, options] = getFetchCall(fetchMock, 0);
      expect(url).toBe('http://localhost:4000/routines?user_id=user_1');
      expect(options.method).toBe('GET');

      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-gw-token');
    });
  });

  describe('deleteRoutine', () => {
    it('sends DELETE to /routines/:id and returns success', async () => {
      const client = makeClient({ gatewayToken: 'test-gw-token' });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const result = await client.deleteRoutine('routine_1');

      expect(result).toEqual({ success: true });

      const [url, options] = getFetchCall(fetchMock, 0);
      expect(url).toBe('http://localhost:4000/routines/routine_1');
      expect(options.method).toBe('DELETE');

      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-gw-token');
    });
  });

  describe('parseChatExecutionResult', () => {
    it('parses a completed chat completion response', () => {
      const client = makeClient();
      const startedAt = new Date();

      const result = client.parseChatExecutionResult('plan_1', {
        content: 'Email archived successfully',
        model: 'openclaw/default',
        usage: { promptTokens: 100, completionTokens: 25 },
        metadata: { taskId: 'task_42' },
      }, startedAt);

      expect(result.planId).toBe('plan_1');
      expect(result.status).toBe('completed');
      expect(result.startedAt).toBe(startedAt);
      expect(result.completedAt).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.output!['ironclawResponse']).toBe('Email archived successfully');
      expect(result.output!['ironclawModel']).toBe('openclaw/default');
      expect(result.output!['ironclawUsage']).toEqual({ promptTokens: 100, completionTokens: 25 });
      expect(result.output!['taskId']).toBe('task_42');
    });

    it('parses a failed chat completion response when content contains error', () => {
      const client = makeClient();

      const result = client.parseChatExecutionResult('plan_2', {
        content: 'Error: unable to send the message',
        model: 'openclaw/default',
        usage: { promptTokens: 50, completionTokens: 10 },
      }, new Date());

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Error: unable to send the message');
    });
  });

  describe('parseExecutionStatus', () => {
    it('returns completed for metadata status "completed"', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: '', attachments: [], metadata: { status: 'completed' } })).toBe('completed');
    });

    it('returns completed for metadata status "success"', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: '', attachments: [], metadata: { status: 'success' } })).toBe('completed');
    });

    it('returns failed for metadata status "failed"', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: '', attachments: [], metadata: { status: 'failed' } })).toBe('failed');
    });

    it('returns failed for metadata status "error"', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: '', attachments: [], metadata: { status: 'error' } })).toBe('failed');
    });

    it('returns pending for metadata status "pending"', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: '', attachments: [], metadata: { status: 'pending' } })).toBe('pending');
    });

    it('returns running for metadata status "running"', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: '', attachments: [], metadata: { status: 'running' } })).toBe('running');
    });

    it('infers pending from content when no metadata status', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: 'Task is pending approval', attachments: [], metadata: {} })).toBe('pending');
    });

    it('infers running from content when no metadata status', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: 'Task is running now', attachments: [], metadata: {} })).toBe('running');
    });

    it('infers running from "in progress" content', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: 'Operation in progress', attachments: [], metadata: {} })).toBe('running');
    });

    it('infers failed from content containing "error"', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: 'An error occurred', attachments: [], metadata: {} })).toBe('failed');
    });

    it('infers failed from content containing "unable"', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: 'Unable to process request', attachments: [], metadata: {} })).toBe('failed');
    });

    it('defaults to completed when content has no failure signals', () => {
      const client = makeClient();
      expect(client.parseExecutionStatus({ content: 'All done', attachments: [], metadata: {} })).toBe('completed');
    });
  });
});
