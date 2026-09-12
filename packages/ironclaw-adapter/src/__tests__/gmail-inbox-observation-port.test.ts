import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  GmailInboxMutationCommand,
  GmailInboxObservationBinding,
  GmailInboxObservationCommand,
  GmailInboxObservationResult,
  GmailInboxObservationUnavailableCode,
} from '@skytwin/shared-types';
import {
  GmailInboxObservationService,
  gmailInboxObservationLimits,
  type GmailInboxObservationCredentialRequest,
  type GmailInboxObservationCredentialsPort,
  type GmailInboxObservationTargetResolver,
} from '../gmail-inbox-observation-port.js';

const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const command: GmailInboxObservationCommand = {
  userId: '11111111-1111-4111-8111-111111111111',
  admissionId: '22222222-22a2-4222-8222-222222222222',
  messageRefId: '33333333-3333-4333-8333-333333333333',
  operation: 'observe_inbox',
};
const binding: GmailInboxObservationBinding = {
  userId: command.userId,
  admissionId: command.admissionId,
  messageRefId: command.messageRefId,
};
const target = {
  connectorAccountId: '44444444-4444-4444-8444-444444444444',
  credentialRevision: '55555555-5555-4555-8555-555555555555',
  providerMessageId: 'native/message id',
};

function boundUnavailable(code: GmailInboxObservationUnavailableCode): GmailInboxObservationResult {
  return { outcome: 'unavailable', code, binding };
}

function jsonResponse(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fixture(options: {
  fetch?: ReturnType<typeof vi.fn>;
  resolve?: ReturnType<typeof vi.fn>;
  materialize?: ReturnType<typeof vi.fn>;
  timeoutMs?: number;
} = {}) {
  const fetchMock = options.fetch ?? vi.fn().mockResolvedValue(
    jsonResponse({ id: target.providerMessageId, labelIds: ['INBOX'] }),
  );
  const resolve = options.resolve ?? vi.fn().mockResolvedValue(target);
  const materialize = options.materialize ?? vi.fn().mockResolvedValue({
    accessToken: 'secret-access-token',
    scopes: [MODIFY_SCOPE],
  });
  const service = new GmailInboxObservationService({
    credentials: {
      materialize: materialize as unknown as GmailInboxObservationCredentialsPort['materialize'],
    },
    targetResolver: {
      resolve: resolve as unknown as GmailInboxObservationTargetResolver['resolve'],
    },
    fetch: fetchMock as unknown as (input: string, init?: RequestInit) => Promise<Response>,
    timeoutMs: options.timeoutMs ?? 1_000,
  });
  return { fetchMock, materialize, resolve, service };
}

async function sourceFilesBelow(directory: URL): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) return sourceFilesBelow(child);
    return /\.(?:ts|js)$/.test(entry.name) ? [await readFile(child, 'utf8')] : [];
  }));
  return nested.flat();
}

describe('GmailInboxObservationService', () => {
  it('keeps observation commands and results structurally distinct from mutation contracts', () => {
    expectTypeOf<GmailInboxObservationCommand>().not.toEqualTypeOf<GmailInboxMutationCommand>();
    expectTypeOf<GmailInboxObservationResult>().not.toEqualTypeOf<{ outcome: 'confirmed' }>();
    const mutation: GmailInboxMutationCommand = { ...command, operation: 'archive' };
    expect(mutation.operation).not.toBe(command.operation);
  });

  it.each([
    null,
    {},
    { ...command, extra: true },
    { ...command, operation: 'archive' },
    { ...command, userId: 'invalid' },
    { ...command, admissionId: command.admissionId.toUpperCase() },
    { ...command, messageRefId: ` ${command.messageRefId}` },
  ])('rejects malformed commands before authority, credentials, or Gmail: %o', async (submitted) => {
    const { fetchMock, materialize, resolve, service } = fixture();

    const result = await service.observe(submitted as GmailInboxObservationCommand);
    expect(result).toEqual({
      outcome: 'unavailable', code: 'invalid_command',
    });
    expect(result).not.toHaveProperty('binding');
    expect(Object.isFrozen(result)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('contains symbols, accessors, null prototypes, and hostile proxies before dependencies', async () => {
    const symbol = { ...command };
    Object.defineProperty(symbol, Symbol('extra'), { enumerable: true, value: true });
    const getter = vi.fn(() => command.userId);
    const accessor = { ...command } as Record<string, unknown>;
    Object.defineProperty(accessor, 'userId', { enumerable: true, get: getter });
    const nullPrototype = Object.assign(Object.create(null), command);
    const revoked = Proxy.revocable({ ...command }, {});
    revoked.revoke();
    const throwing = new Proxy({ ...command }, { ownKeys: () => { throw new Error('contained'); } });
    const { fetchMock, materialize, resolve, service } = fixture();

    for (const submitted of [symbol, accessor, nullPrototype, revoked.proxy, throwing]) {
      await expect(service.observe(submitted as GmailInboxObservationCommand)).resolves.toEqual({
        outcome: 'unavailable', code: 'invalid_command',
      });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('freezes one command snapshot across both authority reads', async () => {
    let release: ((value: typeof target) => void) | undefined;
    const resolve = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof target>((accept) => { release = accept; }))
      .mockResolvedValueOnce(target);
    const { service } = fixture({ resolve });
    const submitted = { ...command, operation: 'observe_inbox' as 'observe_inbox' | 'archive' };

    const pending = service.observe(submitted as GmailInboxObservationCommand);
    submitted.operation = 'archive';
    submitted.userId = '77777777-7777-4777-8777-777777777777';
    submitted.admissionId = '88888888-8888-4888-8888-888888888888';
    submitted.messageRefId = '99999999-9999-4999-8999-999999999999';
    release?.(target);
    const result = await pending;
    expect(result).toMatchObject({ outcome: 'observed', binding });

    expect(resolve).toHaveBeenCalledTimes(2);
    for (const [seen] of resolve.mock.calls) {
      expect(seen).toEqual(command);
      expect(seen).not.toBe(submitted);
      expect(Object.isFrozen(seen)).toBe(true);
    }
    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome === 'observed') expect(Object.isFrozen(result.binding)).toBe(true);
  });

  it('returns an exact frozen secret-free authority binding on observed evidence', async () => {
    const { service } = fixture();
    const result = await service.observe(command);

    expect(result).toEqual({
      outcome: 'observed',
      operation: 'observe_inbox',
      inbox: true,
      observedAt: expect.any(String),
      binding,
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome !== 'observed') throw new Error('expected an observation');
    expect(Object.isFrozen(result.binding)).toBe(true);
    expect(Object.getPrototypeOf(result.binding)).toBe(Object.prototype);
    expect(Object.getOwnPropertySymbols(result.binding)).toEqual([]);
    expect(Object.keys(result.binding).sort()).toEqual([
      'admissionId', 'messageRefId', 'userId',
    ]);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(result.binding))) {
      expect(descriptor).toHaveProperty('value');
      expect(descriptor.enumerable).toBe(true);
      expect(descriptor.get).toBeUndefined();
      expect(descriptor.set).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain(target.connectorAccountId);
    expect(JSON.stringify(result)).not.toContain(target.credentialRevision);
    expect(JSON.stringify(result)).not.toContain(target.providerMessageId);
    expect(JSON.stringify(result)).not.toContain('secret-access-token');
  });

  it('returns the same exact frozen binding on canonical-command unavailability', async () => {
    const { service } = fixture({
      resolve: vi.fn().mockRejectedValueOnce(new Error('private database detail')),
    });
    const result = await service.observe(command);

    expect(result).toEqual(boundUnavailable('authority_unavailable'));
    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome !== 'unavailable' || result.code === 'invalid_command') {
      throw new Error('expected bound unavailability');
    }
    expect(Object.isFrozen(result.binding)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['binding', 'code', 'outcome']);
    expect(Object.keys(result.binding).sort()).toEqual([
      'admissionId', 'messageRefId', 'userId',
    ]);
  });

  it.each([
    ['missing', null, 'not_observable'],
    ['malformed target', { ...target, extra: true }, 'not_observable'],
  ] as const)('stops before credential acquisition when initial authority is %s', async (
    _name,
    resolved,
    code,
  ) => {
    const { fetchMock, materialize, service } = fixture({
      resolve: vi.fn().mockResolvedValueOnce(resolved),
    });
    await expect(service.observe(command)).resolves.toEqual(boundUnavailable(code));
    expect(materialize).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an authority read failure without leaking its error', async () => {
    const { fetchMock, materialize, service } = fixture({
      resolve: vi.fn().mockRejectedValueOnce(new Error('private database detail')),
    });
    await expect(service.observe(command)).resolves.toEqual(boundUnavailable('authority_unavailable'));
    expect(materialize).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a frozen account-bound request to the credential port', async () => {
    const { materialize, service } = fixture();
    await service.observe(command);

    const request = materialize.mock.calls[0]?.[0] as GmailInboxObservationCredentialRequest;
    expect(request).toEqual({
      userId: command.userId,
      connectorAccountId: target.connectorAccountId,
      requiredScope: MODIFY_SCOPE,
    });
    expect(Object.isFrozen(request)).toBe(true);
  });

  it.each([
    ['throw', vi.fn().mockRejectedValue(new Error('secret token detail'))],
    ['missing', vi.fn().mockResolvedValue(null)],
    ['wrong scope', vi.fn().mockResolvedValue({
      accessToken: 'token', scopes: ['gmail.readonly'],
    })],
    ['extra secret field', vi.fn().mockResolvedValue({
      accessToken: 'token', scopes: [MODIFY_SCOPE], refreshToken: 'must-not-flow',
    })],
  ])('returns a secret-free credential failure for %s', async (_name, materialize) => {
    const { fetchMock, service } = fixture({ materialize });
    const result = await service.observe(command);
    expect(result).toEqual(boundUnavailable('credentials_unavailable'));
    expect(JSON.stringify(result)).not.toContain('token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['token deletion or disconnect', null],
    ['target account replacement', { ...target, connectorAccountId: '55555555-5555-4555-8555-555555555555' }],
    ['credential revision rotation', {
      ...target, credentialRevision: '66666666-6666-4666-8666-666666666666',
    }],
    ['native target replacement', { ...target, providerMessageId: 'different-native-id' }],
    ['malformed refreshed target', { ...target, extra: true }],
  ])('performs zero Gmail requests after credential materialization on %s', async (_name, second) => {
    const resolve = vi.fn().mockResolvedValueOnce(target).mockResolvedValueOnce(second);
    const { fetchMock, materialize, service } = fixture({ resolve });
    await expect(service.observe(command)).resolves.toEqual(boundUnavailable('not_observable'));
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('performs exactly one fixed-origin encoded GET with no request body', async () => {
    const { fetchMock, service } = fixture();
    await expect(service.observe(command)).resolves.toMatchObject({
      outcome: 'observed', operation: 'observe_inbox', inbox: true, binding,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/native%2Fmessage%20id' +
        '?format=minimal&fields=id%2ClabelIds',
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer secret-access-token',
          Accept: 'application/json',
          'Cache-Control': 'no-store',
        },
        signal: expect.any(AbortSignal),
        redirect: 'error',
      },
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it.each([
    'native/id?query=yes#fragment',
    'https://attacker.example/path',
    'unicode-☃-信箱',
  ])('keeps hostile opaque provider id %s inside the fixed encoded Gmail path', async (
    providerMessageId,
  ) => {
    const hostileTarget = { ...target, providerMessageId };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: providerMessageId, labelIds: [] }),
    );
    const resolve = vi.fn().mockResolvedValue(hostileTarget);
    const { service } = fixture({ fetch: fetchMock, resolve });

    await expect(service.observe(command)).resolves.toMatchObject({ outcome: 'observed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const called = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(called.origin).toBe('https://gmail.googleapis.com');
    expect(called.pathname).toBe(
      `/gmail/v1/users/me/messages/${encodeURIComponent(providerMessageId)}`,
    );
    expect(called.search).toBe('?format=minimal&fields=id%2ClabelIds');
  });

  it('rejects an unencodable provider id before credential or Gmail use', async () => {
    const fetchMock = vi.fn();
    const materialize = vi.fn();
    const resolve = vi.fn().mockResolvedValue({
      ...target,
      providerMessageId: 'malformed-\ud800-surrogate',
    });
    const { service } = fixture({ fetch: fetchMock, materialize, resolve });

    await expect(service.observe(command)).resolves.toEqual(boundUnavailable('not_observable'));
    expect(materialize).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'credentials_unavailable'],
    [400, 'observation_rejected'],
    [403, 'observation_rejected'],
    [404, 'observation_rejected'],
    [409, 'observation_rejected'],
    [408, 'observation_unavailable'],
    [301, 'observation_unavailable'],
    [399, 'observation_unavailable'],
    [418, 'observation_unavailable'],
    [429, 'observation_unavailable'],
    [500, 'observation_unavailable'],
    [503, 'observation_unavailable'],
    [599, 'observation_unavailable'],
    [204, 'observation_unavailable'],
  ] as const)('maps HTTP %i to %s while cancelling its unparsed error body', async (status, code) => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = { status, body: { cancel } } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(response);
    const { service } = fixture({ fetch: fetchMock });

    await expect(service.observe(command)).resolves.toEqual(boundUnavailable(code));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong id', { id: 'other', labelIds: [] }],
    ['missing id', { labelIds: [] }],
    ['missing labels', { id: target.providerMessageId }],
    ['extra response field', { id: target.providerMessageId, labelIds: [], threadId: 'extra' }],
    ['non-string label', { id: target.providerMessageId, labelIds: [1] }],
    ['too many labels', {
      id: target.providerMessageId,
      labelIds: Array.from({ length: gmailInboxObservationLimits.maxLabelIds + 1 }, () => 'x'),
    }],
    ['oversized label', {
      id: target.providerMessageId,
      labelIds: ['x'.repeat(gmailInboxObservationLimits.maxLabelIdLength + 1)],
    }],
  ])('rejects a 200 response with %s', async (_name, body) => {
    const { service } = fixture({ fetch: vi.fn().mockResolvedValue(jsonResponse(body)) });
    await expect(service.observe(command)).resolves.toEqual(boundUnavailable('observation_unavailable'));
  });

  it('bounds provider response bytes before JSON parsing', async () => {
    const oversized = 'x'.repeat(gmailInboxObservationLimits.maxResponseBytes + 1);
    const { service } = fixture({
      fetch: vi.fn().mockResolvedValue(new Response(oversized, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    });
    await expect(service.observe(command)).resolves.toEqual(boundUnavailable('observation_unavailable'));
  });

  it.each([
    ['truncated JSON', new TextEncoder().encode('{"id":')],
    ['invalid UTF-8', new Uint8Array([0xc3, 0x28])],
  ])('rejects a bounded provider body with %s', async (_name, bytes) => {
    const { fetchMock, service } = fixture({
      fetch: vi.fn().mockResolvedValue(new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    });
    await expect(service.observe(command)).resolves.toEqual(boundUnavailable('observation_unavailable'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'text/plain', 'application/problem+json'])(
    'rejects a 200 response with content type %s',
    async (contentType) => {
      const response = new Response(JSON.stringify({
        id: target.providerMessageId,
        labelIds: [],
      }), {
        status: 200,
        headers: contentType ? { 'Content-Type': contentType } : undefined,
      });
      const { service } = fixture({ fetch: vi.fn().mockResolvedValue(response) });
      await expect(service.observe(command)).resolves.toEqual(boundUnavailable('observation_unavailable'));
    },
  );

  it('keeps the timeout active while the provider body is streaming', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        streamController?.error(new DOMException('aborted', 'AbortError'));
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const { service } = fixture({ fetch: fetchMock, timeoutMs: 10 });

    await expect(service.observe(command)).resolves.toEqual(boundUnavailable('observation_unavailable'));
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it('records observedAt only after delayed bounded provider evidence is accepted', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-12T12:00:00.000Z'));
      let finish: (() => void) | undefined;
      let signalFetchEntered: (() => void) | undefined;
      const fetchEntered = new Promise<void>((resolve) => { signalFetchEntered = resolve; });
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          finish = () => {
            controller.enqueue(encoder.encode(JSON.stringify({
              id: target.providerMessageId,
              labelIds: [],
            })));
            controller.close();
          };
        },
      });
      const { fetchMock, service } = fixture({
        fetch: vi.fn(async () => {
          signalFetchEntered?.();
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      });

      const pending = service.observe(command);
      await fetchEntered;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-09-12T12:00:30.000Z'));
      finish?.();

      await expect(pending).resolves.toEqual({
        outcome: 'observed',
        operation: 'observe_inbox',
        inbox: false,
        observedAt: '2026-09-12T12:00:30.000Z',
        binding,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [[], false],
    [['STARRED'], false],
    [['INBOX'], true],
    [['INBOX', 'UNREAD'], true],
  ])('returns only the observed Inbox fact for labels %o', async (labelIds, inbox) => {
    const { service } = fixture({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ id: target.providerMessageId, labelIds })),
    });
    const result = await service.observe(command);
    expect(result).toEqual({
      outcome: 'observed',
      operation: 'observe_inbox',
      inbox,
      observedAt: expect.any(String),
      binding,
    });
    if (result.outcome === 'observed') {
      expect(new Date(result.observedAt).toISOString()).toBe(result.observedAt);
    }
    expect(JSON.stringify(result)).not.toContain(target.providerMessageId);
    expect(JSON.stringify(result)).not.toContain(target.connectorAccountId);
  });

  it('contains provider fetch failures and returns no native or secret detail', async () => {
    const { service } = fixture({
      fetch: vi.fn().mockRejectedValue(new Error(
        `token=secret-access-token message=${target.providerMessageId}`,
      )),
    });
    const result = await service.observe(command);
    expect(result).toEqual(boundUnavailable('observation_unavailable'));
    expect(JSON.stringify(result)).not.toContain('secret-access-token');
    expect(JSON.stringify(result)).not.toContain(target.providerMessageId);
  });

  it('contains no Gmail mutation, dispatch gate, terminalizer, or router mechanism', async () => {
    const source = await readFile(
      new URL('../gmail-inbox-observation-port.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('/modify');
    expect(source).not.toContain("method: 'POST'");
    expect(source).not.toContain('GmailInboxMutationPort');
    expect(source).not.toContain('dispatchGate');
    expect(source).not.toContain('Terminalization');
    expect(source).not.toContain('ExecutionRouter');
  });

  it('is not constructed by API, worker, or execution-router runtime code', async () => {
    const roots = [
      new URL('../../../../apps/api/', import.meta.url),
      new URL('../../../../apps/worker/', import.meta.url),
      new URL('../../../execution-router/', import.meta.url),
    ];
    const runtimeSources = (await Promise.all(roots.map(sourceFilesBelow))).flat().join('\n');
    expect(runtimeSources).not.toContain('GmailInboxObservationService');
    expect(runtimeSources).not.toContain('DbGmailInboxObservationCredentials');
  });
});
