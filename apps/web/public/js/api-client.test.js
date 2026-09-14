// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KEY_DEMO_SESSION_EXPIRES_AT,
  KEY_SESSION_TOKEN,
  KEY_TOUR_MODE,
  KEY_USER_ID,
} from './storage-keys.js';
import {
  endSampleSimulation,
  fetchJSON,
  resolveAssistantRequestIdentity,
  shouldRetireAssistantRequestIdentity,
  sendAssistantMessage,
  sendAssistantMessageStream,
  sendSampleSimulationCommand,
  startDemoSession,
} from './api-client.js';

const source = readFileSync(new URL('./api-client.js', import.meta.url), 'utf8');
const ASSISTANT_REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const ASSISTANT_STREAM_PREFIX =
  'event: thread\ndata: {"id":"thread-1","isNew":false}\n\n' +
  `event: user\ndata: {"id":"user-message-1","threadId":"thread-1","role":"user","content":"hello","clientRequestId":"${ASSISTANT_REQUEST_ID}"}\n\n`;
const ASSISTANT_DONE =
  `event: done\ndata: {"id":"assistant-1","threadId":"thread-1","role":"assistant","content":"complete","clientRequestId":"${ASSISTANT_REQUEST_ID}"}`;

describe('api client', () => {
  const values = new Map();
  const sampleValues = new Map();

  beforeEach(() => {
    values.clear();
    sampleValues.clear();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key) => sampleValues.get(key) ?? null),
      setItem: vi.fn((key, value) => sampleValues.set(key, String(value))),
      removeItem: vi.fn((key) => sampleValues.delete(key)),
    });
    vi.restoreAllMocks();
  });

  it('treats 204 No Content as a successful empty response', () => {
    expect(source).toContain('if (res.status === 204) return null;');
  });

  it('reuses the request identity only for the same logical assistant message', () => {
    const first = resolveAssistantRequestIdentity(null, 'archive that', 'thread-1');
    const retry = resolveAssistantRequestIdentity(first, 'archive that', 'thread-1');
    const edited = resolveAssistantRequestIdentity(first, 'archive this instead', 'thread-1');
    const otherThread = resolveAssistantRequestIdentity(first, 'archive that', 'thread-2');

    expect(retry).toBe(first);
    expect(edited.requestId).not.toBe(first.requestId);
    expect(otherThread.requestId).not.toBe(first.requestId);
    expect(first.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('retires assistant request identities only after definite failures', () => {
    expect(shouldRetireAssistantRequestIdentity(400, '')).toBe(false);
    expect(shouldRetireAssistantRequestIdentity(409, 'assistant_request_id_conflict')).toBe(true);
    expect(shouldRetireAssistantRequestIdentity(401, '')).toBe(false);
    expect(shouldRetireAssistantRequestIdentity(403, '')).toBe(false);
    expect(shouldRetireAssistantRequestIdentity(429, '')).toBe(false);
    expect(shouldRetireAssistantRequestIdentity(502, 'assistant_providers_failed')).toBe(true);
    expect(shouldRetireAssistantRequestIdentity(502, 'assistant_generation_failed')).toBe(true);
    expect(shouldRetireAssistantRequestIdentity(503, '')).toBe(false);
    expect(
      shouldRetireAssistantRequestIdentity(503, 'assistant_response_reconciliation_required'),
    ).toBe(false);
    expect(shouldRetireAssistantRequestIdentity(0, '')).toBe(false);
  });

  it('sends the caller-supplied requestId on JSON assistant requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendAssistantMessage('user-1', 'hello', 'thread-1', ASSISTANT_REQUEST_ID);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      userId: 'user-1',
      content: 'hello',
      threadId: 'thread-1',
      requestId: ASSISTANT_REQUEST_ID,
    });
  });

  it('keeps one generated requestId through automatic session renewal', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'expired-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: 'renewed-token',
        userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await sendAssistantMessage('user-1', 'hello');

    const assistantCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/assistant/messages');
    expect(assistantCalls).toHaveLength(2);
    const requestIds = assistantCalls.map(([, options]) => JSON.parse(options.body).requestId);
    expect(requestIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(requestIds[1]).toBe(requestIds[0]);
  });

  it('sends the caller-supplied requestId on streaming assistant requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(`${ASSISTANT_STREAM_PREFIX}${ASSISTANT_DONE}\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendAssistantMessageStream(
      'user-1',
      'hello',
      'thread-1',
      {},
      { requestId: ASSISTANT_REQUEST_ID },
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      userId: 'user-1',
      content: 'hello',
      threadId: 'thread-1',
      requestId: ASSISTANT_REQUEST_ID,
    });
  });

  it('rejects a clean assistant stream EOF without a terminal event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        ASSISTANT_STREAM_PREFIX +
        'event: chunk\ndata: {"content":"partial"}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    ));

    await expect(sendAssistantMessageStream(
      'user-1', 'hello', 'thread-1', {}, { requestId: ASSISTANT_REQUEST_ID },
    )).rejects.toMatchObject({ code: 'assistant_stream_terminal_missing' });
  });

  it('rejects a truncated assistant terminal payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(`${ASSISTANT_STREAM_PREFIX}event: done\ndata: {"id":`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    ));

    await expect(sendAssistantMessageStream(
      'user-1', 'hello', 'thread-1', {}, { requestId: ASSISTANT_REQUEST_ID },
    )).rejects.toMatchObject({ code: 'assistant_stream_invalid_terminal' });
  });

  it('accepts a valid done event in the final unterminated SSE fragment', async () => {
    const onDone = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        `${ASSISTANT_STREAM_PREFIX}${ASSISTANT_DONE}`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    ));

    await sendAssistantMessageStream(
      'user-1', 'hello', 'thread-1', { onDone }, { requestId: ASSISTANT_REQUEST_ID },
    );
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ content: 'complete' }));
  });

  it('accepts a validated terminal assistant error', async () => {
    const onError = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        `${ASSISTANT_STREAM_PREFIX}event: error\ndata: {"message":"assistant_stream_failed","partialContent":"partial"}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    ));

    await sendAssistantMessageStream(
      'user-1', 'hello', 'thread-1', { onError }, { requestId: ASSISTANT_REQUEST_ID },
    );
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ partialContent: 'partial' }));
  });

  it('rejects a terminal event bound to another request identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      `${ASSISTANT_STREAM_PREFIX}${ASSISTANT_DONE.replace(ASSISTANT_REQUEST_ID, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )));

    await expect(sendAssistantMessageStream(
      'user-1', 'hello', 'thread-1', {}, { requestId: ASSISTANT_REQUEST_ID },
    )).rejects.toMatchObject({ code: 'assistant_stream_invalid_terminal' });
  });

  it('rejects a persisted user event whose content does not match the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      `${ASSISTANT_STREAM_PREFIX.replace('"content":"hello"', '"content":"other"')}${ASSISTANT_DONE}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )));

    await expect(sendAssistantMessageStream(
      'user-1', 'hello', 'thread-1', {}, { requestId: ASSISTANT_REQUEST_ID },
    )).rejects.toMatchObject({ code: 'assistant_stream_request_mismatch' });
  });

  it('surfaces an unresolved duplicate without parsing JSON as SSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        status: 'unresolved',
        code: 'assistant_request_recovery_required',
        thread: { id: 'thread-1', isNew: false },
        userMessage: {
          id: 'user-message-1',
          threadId: 'thread-1',
          role: 'user',
          content: 'hello',
          clientRequestId: ASSISTANT_REQUEST_ID,
        },
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(sendAssistantMessageStream(
      'user-1',
      'hello',
      null,
      {},
      { requestId: ASSISTANT_REQUEST_ID },
    )).rejects.toMatchObject({
      status: 202,
      code: 'assistant_request_recovery_required',
      threadId: 'thread-1',
    });
  });

  it.each([
    ['another thread', {
      status: 'unresolved',
      code: 'assistant_request_recovery_required',
      thread: { id: 'thread-2', isNew: false },
      userMessage: {
        id: 'user-message-1', threadId: 'thread-2', role: 'user', content: 'hello',
        clientRequestId: ASSISTANT_REQUEST_ID,
      },
    }],
    ['different content', {
      status: 'unresolved',
      code: 'assistant_request_recovery_required',
      thread: { id: 'thread-1', isNew: false },
      userMessage: {
        id: 'user-message-1', threadId: 'thread-1', role: 'user', content: 'other',
        clientRequestId: ASSISTANT_REQUEST_ID,
      },
    }],
    ['another request identity', {
      status: 'unresolved',
      code: 'assistant_request_recovery_required',
      thread: { id: 'thread-1', isNew: false },
      userMessage: {
        id: 'user-message-1', threadId: 'thread-1', role: 'user', content: 'hello',
        clientRequestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
    }],
  ])('does not adopt a 202 response bound to %s', async (_description, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(sendAssistantMessageStream(
      'user-1',
      'hello',
      'thread-1',
      {},
      { requestId: ASSISTANT_REQUEST_ID },
    )).rejects.toMatchObject({
      status: 202,
      code: 'assistant_response_reconciliation_required',
      threadId: null,
    });
  });

  it('does not misclassify a routine policy response as an expired session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: 'Routine deletion was blocked by policy.',
        code: 'routine_blocked_by_policy',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(fetchJSON('/api/routines/routine-1')).rejects.toMatchObject({
      kind: 'bad-request',
      friendlyMessage: 'Routine deletion was blocked by policy.',
      code: 'routine_blocked_by_policy',
    });
  });

  it('stores the credential and expiry when a sample session starts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            token: 'sample-token',
            userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            expiresAt: '2030-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await startDemoSession();

    expect(sampleValues.get(KEY_SESSION_TOKEN)).toBe('sample-token');
    expect(sampleValues.get(KEY_DEMO_SESSION_EXPIRES_AT)).toBe('2030-01-01T00:00:00.000Z');
    expect(values.has(KEY_SESSION_TOKEN)).toBe(false);
  });

  it('renews an expired sample credential once and retries the read', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'expired-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'renewed-token',
            userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            expiresAt: '2030-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'sample-user' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchJSON('/api/users/sample-user')).resolves.toEqual({ id: 'sample-user' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer renewed-token');
  });

  it('reuses one successor when parallel reads receive staggered 401s', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'old-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');

    let releaseFirstRequest;
    const firstRequest = new Promise((resolve) => {
      releaseFirstRequest = resolve;
    });
    let sessionRequests = 0;
    const fetchMock = vi.fn(async (url, options) => {
      if (url === '/api/v1/demo/session') {
        sessionRequests += 1;
        return new Response(JSON.stringify({
          token: `renewed-token-${sessionRequests}`,
          userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          expiresAt: '2030-01-01T00:00:00.000Z',
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (options.headers.Authorization === 'Bearer old-token') {
        if (url === '/api/users/first') return firstRequest;
        return new Response('{}', { status: 401 });
      }
      return new Response(JSON.stringify({ id: url }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchJSON('/api/users/first');
    const second = fetchJSON('/api/users/second');
    await vi.waitFor(() => expect(sessionRequests).toBe(1));
    await expect(second).resolves.toEqual({ id: '/api/users/second' });

    releaseFirstRequest(new Response('{}', { status: 401 }));
    await expect(first).resolves.toEqual({ id: '/api/users/first' });

    expect(sessionRequests).toBe(1);
    const renewedReads = fetchMock.mock.calls.filter(
      ([url, options]) =>
        url !== '/api/v1/demo/session' &&
        options.headers.Authorization === 'Bearer renewed-token-1',
    );
    expect(renewedReads).toHaveLength(2);
  });

  it('joins one renewal when parallel sample reads fail together', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'old-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');

    let releaseRenewal;
    const renewal = new Promise((resolve) => {
      releaseRenewal = resolve;
    });
    let sessionRequests = 0;
    const fetchMock = vi.fn((url, options) => {
      if (url === '/api/v1/demo/session') {
        sessionRequests += 1;
        return renewal;
      }
      if (options.headers.Authorization === 'Bearer old-token') {
        return Promise.resolve(new Response('{}', { status: 401 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: url }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const reads = [
      fetchJSON('/api/users/first'),
      fetchJSON('/api/users/second'),
    ];
    await vi.waitFor(() => expect(sessionRequests).toBe(1));
    releaseRenewal(new Response(JSON.stringify({
      token: 'renewed-token',
      userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(Promise.all(reads)).resolves.toEqual([
      { id: '/api/users/first' },
      { id: '/api/users/second' },
    ]);
    expect(sessionRequests).toBe(1);
  });

  it('does not renew a request that was sent before sample authority existed', async () => {
    let releaseRequest;
    const request = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchJSON('/api/users/anonymous');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'new-sample-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');
    releaseRequest(new Response('{}', { status: 401 }));

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not renew an old sample request after real authentication wins', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'old-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z');
    let releaseRequest;
    const request = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchJSON('/api/users/sample');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    values.set(KEY_SESSION_TOKEN, 'real-token');
    values.set(KEY_USER_ID, '11111111-1111-4111-8111-111111111111');
    releaseRequest(new Response('{}', { status: 401 }));

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(values.get(KEY_SESSION_TOKEN)).toBe('real-token');
  });

  it('never replaces a real session when a stale sample marker survives', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'stale-sample-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2020-01-01T00:00:00.000Z');
    values.set(KEY_USER_ID, '11111111-1111-4111-8111-111111111111');
    values.set(KEY_SESSION_TOKEN, 'real-token');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchJSON('/api/users/real-user')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(values.get(KEY_SESSION_TOKEN)).toBe('real-token');
  });

  it('keeps authentication when a caller supplies additional headers', async () => {
    values.set(KEY_SESSION_TOKEN, 'real-token');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchJSON('/api/protected', {
      headers: { 'X-Request-Mode': 'test' },
    });

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer real-token',
      'Content-Type': 'application/json',
      'X-Request-Mode': 'test',
    });
  });

  it('deletes disposable state with the original token without renewal', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'expired-sample-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2020-01-01T00:00:00.000Z');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(endSampleSimulation()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'DELETE',
      headers: { Authorization: 'Bearer expired-sample-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('does not replay a command into a replacement session after expiry', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    sampleValues.set(KEY_SESSION_TOKEN, 'expired-sample-token');
    sampleValues.set(KEY_DEMO_SESSION_EXPIRES_AT, '2020-01-01T00:00:00.000Z');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Sample session expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendSampleSimulationCommand({
        type: 'approve',
        proposalId: 'calendar-focus',
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer expired-sample-token',
    );
    expect(sampleValues.get(KEY_SESSION_TOKEN)).toBe('expired-sample-token');
  });

  it('rejects a sample credential for any other identity before storing it', async () => {
    sampleValues.set(KEY_TOUR_MODE, '1');
    sampleValues.set(KEY_SESSION_TOKEN, 'old-token');
    sampleValues.set(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            token: 'wrong-token',
            userId: '00000000-0000-4000-8000-000000000000',
            expiresAt: '2030-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(startDemoSession()).rejects.toThrow(/invalid/i);
    expect(sampleValues.has(KEY_SESSION_TOKEN)).toBe(false);
    expect(sampleValues.has(KEY_TOUR_MODE)).toBe(false);
    expect(sampleValues.has(KEY_USER_ID)).toBe(false);
  });

  for (const responseKind of ['valid', 'invalid']) {
    it(`preserves a real session established during an in-flight ${responseKind} sample response`, async () => {
      let resolveFetch;
      const pendingResponse = new Promise((resolve) => {
        resolveFetch = resolve;
      });
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingResponse));

      const starting = startDemoSession();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      values.set(KEY_USER_ID, '11111111-1111-4111-8111-111111111111');
      values.set(KEY_SESSION_TOKEN, 'real-token');

      resolveFetch(new Response(JSON.stringify(responseKind === 'valid' ? {
        token: 'late-sample-token',
        userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        expiresAt: '2030-01-01T00:00:00.000Z',
      } : { token: '', userId: 'wrong' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));

      await expect(starting).rejects.toThrow(/authentication changed/i);
      expect(values.get(KEY_USER_ID)).toBe('11111111-1111-4111-8111-111111111111');
      expect(values.get(KEY_SESSION_TOKEN)).toBe('real-token');
      expect(sampleValues.has(KEY_SESSION_TOKEN)).toBe(false);
      expect(sampleValues.has(KEY_TOUR_MODE)).toBe(false);
      expect(sampleValues.has(KEY_DEMO_SESSION_EXPIRES_AT)).toBe(false);
    });
  }
});
