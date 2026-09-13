import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealIronClawAdapter } from '../real-adapter.js';
import type { CandidateAction } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'act_1',
    decisionId: 'dec_1',
    actionType: 'archive_email',
    description: 'Archive the newsletter email',
    domain: 'email',
    parameters: { emailId: 'msg_123', userId: 'user_1' },
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'User always archives newsletters',
    ...overrides,
  };
}

function makeAdapter(overrides: { maxRetries?: number; preferChatCompletions?: boolean } = {}): RealIronClawAdapter {
  return new RealIronClawAdapter({
    apiUrl: 'http://localhost:4000',
    webhookSecret: 'test-secret-key',
    ownerId: 'test-owner',
    maxRetries: overrides.maxRetries ?? 0, // No retries in tests for speed
    preferChatCompletions: overrides.preferChatCompletions,
  });
}

/** Extract the URL and init from a fetch mock call */
function getFetchCall(mock: ReturnType<typeof vi.fn>, index: number): [string, RequestInit] {
  const call = mock.mock.calls[index] as [string | URL | Request, RequestInit | undefined];
  return [String(call[0]), call[1] ?? {}];
}

describe('RealIronClawAdapter (HTTP)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  describe('buildPlan', () => {
    it('builds a plan from a candidate action', async () => {
      const adapter = makeAdapter();
      const action = makeAction();
      const plan = await adapter.buildPlan(action);

      expect(plan.id).toMatch(/^plan_/);
      expect(plan.decisionId).toBe('dec_1');
      expect(plan.action).toBe(action);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]!.type).toBe('archive_email');
      expect(plan.rollbackSteps).toHaveLength(1); // reversible action
    });

    it('does not create rollback steps for irreversible actions', async () => {
      const adapter = makeAdapter();
      const action = makeAction({ reversible: false });
      const plan = await adapter.buildPlan(action);

      expect(plan.rollbackSteps).toHaveLength(0);
    });
  });

  describe('execute', () => {
    it('sends execution request to IronClaw webhook', async () => {
      const adapter = makeAdapter();

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: 'Successfully archived email msg_123',
            thread_id: 'thread_abc',
            attachments: [],
            metadata: {
              status: 'completed',
              outputs: { messageId: 'msg_123', action: 'archived' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const plan = await adapter.buildPlan(makeAction());
      const result = await adapter.execute(plan);

      expect(result.status).toBe('completed');
      expect(result.planId).toBe(plan.id);
      expect(result.output).toBeDefined();
      expect(result.output!['ironclawResponse']).toBe('Successfully archived email msg_123');

      // Verify the webhook was called correctly
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = getFetchCall(fetchMock, 0);
      expect(url).toBe('http://localhost:4000/webhook');
      expect(options.method).toBe('POST');

      const headers = options.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Signature-256']).toMatch(/^sha256=/);
      expect(headers['X-IronClaw-Channel']).toBe('skytwin');

      // Verify the message body
      const body = JSON.parse(options.body as string);
      expect(body.channel).toBe('skytwin');
      expect(body.owner_id).toBe('test-owner');
      expect(body.metadata.skytwin).toBe(true);
      expect(body.metadata.message_type).toBe('execute');
      expect(body.metadata.action.type).toBe('archive_email');
      expect(body.metadata.idempotency_key).toBe(plan.id);
    });

    it('returns failed result when IronClaw returns error status', async () => {
      const adapter = makeAdapter();

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: 'Failed to archive: permission denied',
            attachments: [],
            metadata: {
              status: 'failed',
              error: 'Gmail API returned 403',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const plan = await adapter.buildPlan(makeAction());
      const result = await adapter.execute(plan);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Gmail API returned 403');
    });

    it('leaves an HTTP error after dispatch ambiguous without retrying the POST', async () => {
      const adapter = makeAdapter({ maxRetries: 2 });

      fetchMock.mockResolvedValue(
        new Response('Internal Server Error', { status: 500 }),
      );

      const plan = await adapter.buildPlan(makeAction());
      await expect(adapter.execute(plan)).rejects.toThrow('500');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('leaves network response loss after dispatch ambiguous without retrying the POST', async () => {
      const adapter = makeAdapter({ maxRetries: 2 });

      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const plan = await adapter.buildPlan(makeAction());
      await expect(adapter.execute(plan)).rejects.toThrow('ECONNREFUSED');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sanitizes sensitive parameters in the message', async () => {
      const adapter = makeAdapter();

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: 'Done',
            attachments: [],
            metadata: { status: 'completed' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const action = makeAction({
        parameters: {
          emailId: 'msg_123',
          accessToken: 'super-secret-token',
          apiKey: 'secret-api-key',
        },
      });
      const plan = await adapter.buildPlan(action);
      await adapter.execute(plan);

      const [, sanitizeOptions] = getFetchCall(fetchMock, 0);
      const sanitizeBody = JSON.parse(sanitizeOptions.body as string);
      const actionMeta = sanitizeBody.metadata.action;

      // Sensitive fields should be replaced with references
      expect(actionMeta.parameters['accessToken_ref']).toBe('[managed-by-ironclaw]');
      expect(actionMeta.parameters['apiKey_ref']).toBe('[managed-by-ironclaw]');
      expect(actionMeta.parameters['accessToken']).toBeUndefined();
      expect(actionMeta.parameters['apiKey']).toBeUndefined();

      // Non-sensitive fields should be preserved
      expect(actionMeta.parameters['emailId']).toBe('msg_123');
    });

    it('uses plan ID as thread_id for correlation', async () => {
      const adapter = makeAdapter();

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: 'Done',
            thread_id: 'thread_123',
            attachments: [],
            metadata: { status: 'completed' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const plan = await adapter.buildPlan(makeAction());
      await adapter.execute(plan);

      const [, threadOptions] = getFetchCall(fetchMock, 0);
      const threadBody = JSON.parse(threadOptions.body as string);
      expect(threadBody.thread_id).toBe(plan.id);
    });

    it('rejects completion prose when metadata has no explicit status', async () => {
      const adapter = makeAdapter();

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: 'Email archived successfully',
            attachments: [],
            metadata: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const plan = await adapter.buildPlan(makeAction());
      await expect(adapter.execute(plan)).rejects.toThrow('omitted explicit execution status');
      await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
    });

    it('rejects failure prose when metadata has no explicit status', async () => {
      const adapter = makeAdapter();

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: 'Error: unable to process request',
            attachments: [],
            metadata: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const plan = await adapter.buildPlan(makeAction());
      await expect(adapter.execute(plan)).rejects.toThrow('omitted explicit execution status');
      await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
    });

    it.each([
      { status: 'completed', success: false },
      { status: 'failed', success: true },
      { status: 'completed', error: 'conflicting error' },
      { status: 'failed', error: { message: 'malformed' } },
      { status: 'completed', error: { message: 'malformed' } },
      { status: 'running' },
    ])('rejects inconsistent or non-terminal webhook metadata %#', async (metadata) => {
      const adapter = makeAdapter();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        content: 'untrusted prose', attachments: [], metadata,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const plan = await adapter.buildPlan(makeAction());
      await expect(adapter.execute(plan)).rejects.toThrow();
      await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
    });

    it.each([
      ['HTTP 500', () => Promise.resolve(new Response('lost', { status: 500 }))],
      ['response loss', () => Promise.reject(new Error('response lost after commit'))],
    ] as const)('does not retry an effect-bearing chat POST after %s', async (_label, reply) => {
      const adapter = makeAdapter({ maxRetries: 2, preferChatCompletions: true });
      fetchMock.mockImplementationOnce(reply);

      const plan = await adapter.buildPlan(makeAction());
      await expect(adapter.execute(plan)).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
    });
  });

  describe('executeStreaming terminal authority', () => {
    async function consume(adapter: RealIronClawAdapter, action = makeAction()): Promise<string[]> {
      const plan = await adapter.buildPlan(action);
      const events: string[] = [];
      for await (const event of adapter.executeStreaming(plan)) events.push(event.eventType);
      return events;
    }

    it('treats clean EOF without an explicit terminal event as ambiguous', async () => {
      fetchMock.mockResolvedValueOnce(new Response(
        'data: {"eventType":"plan_started"}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));

      await expect(consume(makeAdapter())).rejects.toThrow('without an explicit terminal event');
    });

    it('rejects conflicting terminal events instead of choosing one', async () => {
      fetchMock.mockResolvedValueOnce(new Response(
        'data: {"eventType":"plan_completed"}\n\n' +
          'data: {"eventType":"plan_failed"}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));

      await expect(consume(makeAdapter())).rejects.toThrow('event after terminal plan_completed');
    });

    it('does not publish a buffered terminal event when the stream is lost afterward', async () => {
      const encoder = new TextEncoder();
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(encoder.encode('data: {"eventType":"plan_completed"}\n\n'));
          } else {
            controller.error(new Error('stream response lost'));
          }
        },
      });
      fetchMock.mockResolvedValueOnce(new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

      await expect(consume(makeAdapter())).rejects.toThrow('stream response lost');
    });
  });

  describe('getStatus', () => {
    it('sends a status query through IronClaw webhook', async () => {
      const adapter = makeAdapter();

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: 'Plan is running',
            attachments: [],
            metadata: { status: 'running' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const status = await adapter.getStatus('plan_status_1');

      expect(status).toBe('running');
      const [, options] = getFetchCall(fetchMock, 0);
      const body = JSON.parse(options.body as string);
      expect(body.metadata.message_type).toBe('status');
      expect(body.metadata.plan_id).toBe('plan_status_1');
    });
  });

  describe('rollback', () => {
    it('sends rollback request to IronClaw with thread correlation', async () => {
      const adapter = makeAdapter();

      // First execute to establish thread
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: 'Archived',
            thread_id: 'thread_xyz',
            attachments: [],
            metadata: { status: 'completed' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const plan = await adapter.buildPlan(makeAction());
      await adapter.execute(plan);

      // Then rollback
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: 'Successfully rolled back archive',
            attachments: [],
            metadata: { status: 'completed' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const result = await adapter.rollback(plan.id);

      expect(result.success).toBe(true);
      expect(result.message).toContain('rolled back');

      // Verify rollback message uses the same thread
      const [, rollbackOptions] = getFetchCall(fetchMock, 1);
      const rollbackBody = JSON.parse(rollbackOptions.body as string);
      expect(rollbackBody.thread_id).toBe('thread_xyz');
      expect(rollbackBody.metadata.message_type).toBe('rollback');
      expect(rollbackBody.metadata.plan_id).toBe(plan.id);
    });

    it('handles rollback failure from IronClaw', async () => {
      const adapter = makeAdapter();

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: 'Cannot undo: email was sent',
            attachments: [],
            metadata: { status: 'failed', error: 'Cannot undo sent email' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const result = await adapter.rollback('plan_123');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Cannot undo');
    });

    it('handles rollback network failure', async () => {
      const adapter = makeAdapter();

      fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await adapter.rollback('plan_123');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection refused');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy when IronClaw responds OK', async () => {
      const adapter = makeAdapter();

      fetchMock.mockResolvedValueOnce(
        new Response('OK', { status: 200 }),
      );

      const health = await adapter.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:4000/health',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns unhealthy when IronClaw is down', async () => {
      const adapter = makeAdapter();

      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const health = await adapter.healthCheck();
      expect(health.healthy).toBe(false);
    });

    it('returns unhealthy when IronClaw returns non-200', async () => {
      const adapter = makeAdapter();

      fetchMock.mockResolvedValueOnce(
        new Response('Service Unavailable', { status: 503 }),
      );

      const health = await adapter.healthCheck();
      expect(health.healthy).toBe(false);
    });
  });
});
