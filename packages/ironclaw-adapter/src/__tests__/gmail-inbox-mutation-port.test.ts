import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveTargetMock = vi.fn();
const refreshIfExpiredMock = vi.fn();
const tokenStoreConstructorMock = vi.fn();
const dispatchGateEnterMock = vi.fn();

vi.mock('@skytwin/db', () => ({
  GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA: 'gmail_inbox_mutation_v1',
  gmailMessageRefRepository: {
    resolveInboxMutationTarget: resolveTargetMock,
  },
  oauthRepository: { name: 'oauth-repository' },
}));

vi.mock('@skytwin/connectors', () => ({
  DbTokenStore: class {
    constructor(...args: unknown[]) {
      tokenStoreConstructorMock(...args);
    }

    setKeyCache(_cache: unknown): void {}

    refreshIfExpired(...args: unknown[]) {
      return refreshIfExpiredMock(...args);
    }
  },
}));

const { GmailInboxMutationService } = await import('../gmail-inbox-mutation-port.js');

const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const command = {
  userId: '11111111-1111-4111-8111-111111111111',
  admissionId: '22222222-2222-4222-8222-222222222222',
  messageRefId: '33333333-3333-4333-8333-333333333333',
  operation: 'archive' as const,
};
const target = {
  connector_account_id: '44444444-4444-4444-8444-444444444444',
  provider_message_id: 'native/message id',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function service(fetchMock: ReturnType<typeof vi.fn>, timeoutMs = 1_000) {
  return new GmailInboxMutationService({
    googleOAuthConfig: { clientId: 'client', clientSecret: '', redirectUri: 'http://localhost' },
    dispatchGate: { enter: dispatchGateEnterMock },
    fetch: fetchMock as unknown as (input: string, init?: RequestInit) => Promise<Response>,
    timeoutMs,
  });
}

function admitOnce(row = target): void {
  resolveTargetMock.mockResolvedValueOnce({
    connectorAccountId: row.connector_account_id,
    providerMessageId: row.provider_message_id,
  });
}

function admitForPost(row = target): void {
  admitOnce(row);
  admitOnce(row);
}

describe('GmailInboxMutationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshIfExpiredMock.mockResolvedValue({
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [MODIFY_SCOPE],
      provider: 'google',
    });
    dispatchGateEnterMock.mockResolvedValue({ status: 'entered' });
  });

  it('rejects non-canonical commands before any authority or network read', async () => {
    const fetchMock = vi.fn();
    const result = await service(fetchMock).mutate({
      ...command,
      providerMessageId: 'caller-controlled',
    } as typeof command);

    expect(result).toEqual({
      outcome: 'known_failure', code: 'invalid_command', compensationAvailable: false,
    });
    expect(resolveTargetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['userId', 'x'],
    ['userId', ` ${command.userId}`],
    ['admissionId', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],
    ['messageRefId', 'x'.repeat(129)],
  ] as const)('rejects malformed canonical id %s before DB or fetch', async (field, value) => {
    const fetchMock = vi.fn();
    const result = await service(fetchMock).mutate({ ...command, [field]: value });

    expect(result).toEqual({
      outcome: 'known_failure', code: 'invalid_command', compensationAvailable: false,
    });
    expect(resolveTargetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects accessor commands without evaluating authority-bearing getters', async () => {
    const fetchMock = vi.fn();
    const operationGetter = vi.fn(() => 'archive');
    const accessorCommand = { ...command };
    Object.defineProperty(accessorCommand, 'operation', {
      enumerable: true,
      get: operationGetter,
    });

    const result = await service(fetchMock).mutate(accessorCommand);

    expect(result).toMatchObject({ outcome: 'known_failure', code: 'invalid_command' });
    expect(operationGetter).not.toHaveBeenCalled();
    expect(resolveTargetMock).not.toHaveBeenCalled();
  });

  it('contains hostile proxy introspection inside the typed invalid-command boundary', async () => {
    const fetchMock = vi.fn();
    const { proxy, revoke } = Proxy.revocable({ ...command }, {});
    revoke();

    const result = await service(fetchMock).mutate(proxy);

    expect(result).toMatchObject({ outcome: 'known_failure', code: 'invalid_command' });
    expect(resolveTargetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('snapshots the command before awaits and ignores caller mutation in flight', async () => {
    let releaseFirst: ((value: { connectorAccountId: string; providerMessageId: string }) => void) | undefined;
    resolveTargetMock
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce({
        connectorAccountId: target.connector_account_id,
        providerMessageId: target.provider_message_id,
      });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ labelIds: [] }));
    const submitted = { ...command, operation: 'archive' as 'archive' | 'restore' };

    const pending = service(fetchMock).mutate(submitted as typeof command);
    submitted.operation = 'restore';
    submitted.messageRefId = '99999999-9999-4999-8999-999999999999';
    releaseFirst?.({
      connectorAccountId: target.connector_account_id,
      providerMessageId: target.provider_message_id,
    });
    const result = await pending;

    expect(resolveTargetMock).toHaveBeenCalledTimes(2);
    for (const [snapshot] of resolveTargetMock.mock.calls) {
      expect(snapshot).toEqual(command);
      expect(snapshot).not.toBe(submitted);
    }
    const post = fetchMock.mock.calls.find((entry) => entry[1]?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      addLabelIds: [], removeLabelIds: ['INBOX'],
    });
    expect(result).toMatchObject({ outcome: 'confirmed', operation: 'archive', inbox: false });
  });

  it('passes only the narrow command to the trusted repository resolver', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ labelIds: [] }));
    admitOnce();

    await service(fetchMock).mutate(command);

    expect(resolveTargetMock).toHaveBeenCalledWith(command);
  });

  it('does not materialize credentials or call Gmail when admission resolution fails', async () => {
    const fetchMock = vi.fn();
    resolveTargetMock.mockResolvedValueOnce(null);

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({ outcome: 'known_failure', code: 'not_admitted', compensationAvailable: false });
    expect(refreshIfExpiredMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies an unavailable initial admission read without dispatch', async () => {
    const fetchMock = vi.fn();
    resolveTargetMock.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'known_failure', code: 'admission_unavailable', compensationAvailable: false,
    });
    expect(refreshIfExpiredMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses an account-bound token store and requires exact returned scope membership', async () => {
    const fetchMock = vi.fn();
    admitOnce();
    refreshIfExpiredMock.mockResolvedValueOnce({
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [`prefix:${MODIFY_SCOPE}:suffix`],
      provider: 'google',
    });

    const result = await service(fetchMock).mutate(command);

    expect(tokenStoreConstructorMock.mock.calls[0]?.[3]).toBe(target.connector_account_id);
    expect(refreshIfExpiredMock).toHaveBeenCalledWith(command.userId, 'google');
    expect(result).toEqual({
      outcome: 'known_failure', code: 'credentials_unavailable', compensationAvailable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats an already-archived preflight as confirmed without a POST', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'ignored', labelIds: ['STARRED'] }));
    admitOnce();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'confirmed', operation: 'archive', inbox: false,
      effect: 'already_in_state', compensationAvailable: false, observedAt: expect.any(String),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('timestamps provider observation before response-body parsing', async () => {
    vi.useFakeTimers();
    try {
      const headersAt = new Date('2026-09-11T13:00:00.000Z');
      const parsedAt = new Date('2026-09-11T13:00:10.000Z');
      vi.setSystemTime(headersAt);
      const providerResponse = {
        ok: true,
        status: 200,
        json: async () => {
          vi.setSystemTime(parsedAt);
          return { labelIds: [] };
        },
      } as Response;
      const fetchMock = vi.fn().mockResolvedValueOnce(providerResponse);
      admitOnce();

      const result = await service(fetchMock).mutate(command);

      expect(result).toMatchObject({
        outcome: 'confirmed',
        observedAt: headersAt.toISOString(),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('archives with exactly one POST that removes only INBOX', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX', 'STARRED'] }))
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['STARRED'] }));
    admitForPost();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'confirmed', operation: 'archive', inbox: false,
      effect: 'changed', compensationAvailable: false, observedAt: expect.any(String),
    });
    const posts = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0]).toContain('native%2Fmessage%20id/modify?fields=');
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({
      addLabelIds: [], removeLabelIds: ['INBOX'],
    });
    expect(JSON.stringify(result)).not.toContain(target.provider_message_id);
    expect(JSON.stringify(result)).not.toContain('secret-access-token');
  });

  it('rejects restore because durable compensation is not part of this boundary', async () => {
    const restore = { ...command, operation: 'restore' as const };
    const fetchMock = vi.fn();

    const result = await service(fetchMock).mutate(restore as unknown as typeof command);

    expect(result).toEqual({
      outcome: 'known_failure', code: 'invalid_command', compensationAvailable: false,
    });
    expect(resolveTargetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revalidates current authority immediately before POST', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }));
    admitOnce();
    resolveTargetMock.mockResolvedValueOnce(null);

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({ outcome: 'known_failure', code: 'not_admitted', compensationAvailable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('classifies an unavailable pre-POST admission revalidation without dispatch', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }));
    admitOnce();
    resolveTargetMock.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'known_failure', code: 'admission_unavailable', compensationAvailable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it.each([400, 401, 403, 404, 409])(
    'maps deterministic preflight %i to a known failure without POST',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'redacted' }, status));
      admitOnce();

      const result = await service(fetchMock).mutate(command);

      expect(result).toEqual({
        outcome: 'known_failure', code: 'remote_rejected', compensationAvailable: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([408, 429, 500, 503])(
    'maps unavailable preflight %i to a known failure without POST',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'redacted' }, status));
      admitOnce();

      const result = await service(fetchMock).mutate(command);

      expect(result).toEqual({
        outcome: 'known_failure', code: 'preflight_unavailable', compensationAvailable: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resolveTargetMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['missing labels', { id: 'message' }],
    ['wrong label shape', { labelIds: 'INBOX' }],
    ['invalid JSON', null],
  ] as const)('maps malformed preflight %s to a known failure without POST', async (_label, body) => {
    const response = body === null
      ? new Response('not-json', { status: 200 })
      : jsonResponse(body);
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    admitOnce();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'known_failure', code: 'preflight_unavailable', compensationAvailable: false,
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
    expect(resolveTargetMock).toHaveBeenCalledTimes(1);
  });

  it('maps a deterministic mutation rejection to known failure without reconciliation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'redacted' }, 403));
    admitForPost();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'known_failure', code: 'remote_rejected', compensationAvailable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveTargetMock).toHaveBeenCalledTimes(2);
  });

  it('reconciles a retryable mutation response with one read and never retries POST', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'redacted' }, 503))
      .mockResolvedValueOnce(jsonResponse({ labelIds: [] }));
    admitForPost();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'confirmed', operation: 'archive', inbox: false,
      effect: 'reconciled', compensationAvailable: false, observedAt: expect.any(String),
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'GET')).toHaveLength(2);
  });

  it('returns unknown after a network-ambiguous POST and one inconclusive reconciliation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }));
    admitForPost();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'unknown', code: 'remote_outcome_unknown', compensationAvailable: false,
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(resolveTargetMock).toHaveBeenCalledTimes(2);
  });

  it('returns unknown for malformed mutation and reconciliation responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ labelIds: 'not-an-array' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'missing-labels' }));
    admitForPost();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'unknown', code: 'remote_outcome_unknown', compensationAvailable: false,
    });
    expect(resolveTargetMock).toHaveBeenCalledTimes(2);
  });

  it('uses an owned AbortController and classifies preflight timeout as a known failure', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      capturedSignal = init?.signal ?? undefined;
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    admitOnce();

    const result = await service(fetchMock, 1).mutate(command);

    expect(result).toEqual({
      outcome: 'known_failure', code: 'preflight_unavailable', compensationAvailable: false,
    });
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts a timed-out POST and reconciles with one fresh read controller', async () => {
    const signals: AbortSignal[] = [];
    let call = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit): Promise<Response> => {
      call += 1;
      if (init?.signal) signals.push(init.signal);
      if (call === 1) return Promise.resolve(jsonResponse({ labelIds: ['INBOX'] }));
      if (call === 2) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve(jsonResponse({ labelIds: [] }));
    });
    admitForPost();

    const result = await service(fetchMock, 2).mutate(command);

    expect(result).toMatchObject({
      outcome: 'confirmed', effect: 'reconciled', compensationAvailable: false,
    });
    expect(fetchMock.mock.calls.filter((entry) => entry[1]?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((entry) => entry[1]?.method === 'GET')).toHaveLength(2);
    expect(signals).toHaveLength(3);
    expect(signals[1]?.aborted).toBe(true);
    expect(signals[2]).not.toBe(signals[1]);
    expect(signals[2]?.aborted).toBe(false);
  });

  it('returns provider truth for later primary lifecycle finalization', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ labelIds: [] }));
    admitOnce();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'confirmed', operation: 'archive', inbox: false,
      effect: 'already_in_state', compensationAvailable: false, observedAt: expect.any(String),
    });
  });
});
