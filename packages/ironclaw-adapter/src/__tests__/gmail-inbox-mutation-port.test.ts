import { readFile, readdir } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GmailInboxMutationServiceOptions } from '../gmail-inbox-mutation-port.js';

const resolveTargetMock = vi.fn();
const refreshIfExpiredMock = vi.fn();
const tokenStoreConstructorMock = vi.fn();
const tokenStoreAuditMock = vi.fn();
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

    setAuditLog(...args: unknown[]): void {
      tokenStoreAuditMock(...args);
    }

    refreshIfExpiredWithRevision(...args: unknown[]) {
      return refreshIfExpiredMock(...args);
    }
  },
}));

const { GmailInboxMutationService, gmailInboxMutationLimits } =
  await import('../gmail-inbox-mutation-port.js');

const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const command = {
  userId: '11111111-1111-4111-8111-111111111111',
  admissionId: '22222222-2222-4222-8222-222222222222',
  messageRefId: '33333333-3333-4333-8333-333333333333',
  operation: 'archive' as const,
};
const binding = {
  userId: command.userId,
  admissionId: command.admissionId,
  messageRefId: command.messageRefId,
};
const target = {
  connector_account_id: '44444444-4444-4444-8444-444444444444',
  credential_revision: '55555555-5555-4555-8555-555555555555',
  provider_message_id: 'native/message id',
};

function jsonResponse(value: unknown, status = 200): Response {
  const body = value && typeof value === 'object' && !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'labelIds') &&
    !Object.prototype.hasOwnProperty.call(value, 'id')
    ? { id: target.provider_message_id, ...(value as Record<string, unknown>) }
    : value;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

function service(fetchMock: ReturnType<typeof vi.fn>, timeoutMs = 1_000) {
  return new GmailInboxMutationService({
    googleOAuthConfig: { clientId: 'client', clientSecret: '', redirectUri: 'http://localhost' },
    dispatchGate: { enter: dispatchGateEnterMock },
    fetch: fetchMock as unknown as (input: string, init?: RequestInit) => Promise<Response>,
    timeoutMs,
  });
}

function admitOnce(row = target): void {
  const resolved = {
    connectorAccountId: row.connector_account_id,
    credentialRevision: row.credential_revision,
    providerMessageId: row.provider_message_id,
  };
  resolveTargetMock.mockResolvedValueOnce(resolved).mockResolvedValueOnce(resolved);
}

function admitForPost(row = target): void {
  admitOnce(row);
  resolveTargetMock.mockResolvedValueOnce({
    connectorAccountId: row.connector_account_id,
    credentialRevision: row.credential_revision,
    providerMessageId: row.provider_message_id,
  });
}

describe('GmailInboxMutationService', () => {
  beforeEach(() => {
    resolveTargetMock.mockReset();
    refreshIfExpiredMock.mockReset();
    tokenStoreConstructorMock.mockReset();
    tokenStoreAuditMock.mockReset();
    dispatchGateEnterMock.mockReset();
    refreshIfExpiredMock.mockResolvedValue({
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [MODIFY_SCOPE],
      provider: 'google',
      credentialRevision: target.credential_revision,
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

  it('rejects symbol-bearing and null-prototype command lookalikes before dependencies', async () => {
    const symbolBearing = { ...command };
    Object.defineProperty(symbolBearing, Symbol('extra'), { enumerable: true, value: true });
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, command);

    for (const submitted of [symbolBearing, nullPrototype]) {
      await expect(service(vi.fn()).mutate(
        submitted as unknown as typeof command,
      )).resolves.toEqual({
        outcome: 'known_failure', code: 'invalid_command', compensationAvailable: false,
      });
    }
    expect(resolveTargetMock).not.toHaveBeenCalled();
    expect(refreshIfExpiredMock).not.toHaveBeenCalled();
  });

  it('snapshots the command before awaits and ignores caller mutation in flight', async () => {
    let releaseFirst: ((value: {
      connectorAccountId: string;
      credentialRevision: string;
      providerMessageId: string;
    }) => void) | undefined;
    const resolvedTarget = {
      connectorAccountId: target.connector_account_id,
      credentialRevision: target.credential_revision,
      providerMessageId: target.provider_message_id,
    };
    resolveTargetMock
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(resolvedTarget)
      .mockResolvedValueOnce(resolvedTarget);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ labelIds: [] }));
    const submitted = { ...command, operation: 'archive' as 'archive' | 'restore' };

    const pending = service(fetchMock).mutate(submitted as typeof command);
    submitted.operation = 'restore';
    submitted.messageRefId = '99999999-9999-4999-8999-999999999999';
    releaseFirst?.(resolvedTarget);
    const result = await pending;

    expect(resolveTargetMock).toHaveBeenCalledTimes(3);
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

    expect(result).toEqual({
      outcome: 'known_failure', code: 'not_admitted', compensationAvailable: false, binding,
    });
    expect(refreshIfExpiredMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies an unavailable initial admission read without dispatch', async () => {
    const fetchMock = vi.fn();
    resolveTargetMock.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'known_failure', code: 'admission_unavailable', compensationAvailable: false, binding,
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
      outcome: 'known_failure', code: 'credentials_unavailable', compensationAvailable: false, binding,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wires credential-vault audit attribution into the account-bound token store', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ labelIds: [] }));
    const auditLog = { recordAccess: vi.fn() };
    const configured = new GmailInboxMutationService({
      googleOAuthConfig: { clientId: 'client', clientSecret: '', redirectUri: 'http://localhost' },
      dispatchGate: { enter: dispatchGateEnterMock },
      fetch: fetchMock as unknown as (input: string, init?: RequestInit) => Promise<Response>,
      auditLog,
      auditActor: 'archive-kernel',
    });
    admitOnce();
    await configured.mutate(command);

    expect(tokenStoreAuditMock).toHaveBeenLastCalledWith(
      { recordAccess: expect.any(Function) },
      'archive-kernel',
    );
    const snapshottedAudit = tokenStoreAuditMock.mock.calls.at(-1)?.[0] as {
      recordAccess(input: Parameters<typeof auditLog.recordAccess>[0]): void;
    };
    const auditInput = {
      userId: command.userId,
      actor: 'archive-kernel',
      action: 'decrypt_oauth_token',
      resourceType: 'oauth_token',
    };
    snapshottedAudit.recordAccess(auditInput);
    expect(auditLog.recordAccess).toHaveBeenCalledWith(auditInput);
  });

  it('accepts a credential refresh only after the resolver reaches the materialized revision', async () => {
    const refreshedRevision = '66666666-6666-4666-8666-666666666666';
    const initial = {
      connectorAccountId: target.connector_account_id,
      credentialRevision: target.credential_revision,
      providerMessageId: target.provider_message_id,
    };
    const refreshed = { ...initial, credentialRevision: refreshedRevision };
    resolveTargetMock
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(refreshed);
    refreshIfExpiredMock.mockResolvedValueOnce({
      accessToken: 'refreshed-access-token',
      refreshToken: 'secret-refresh-token',
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [MODIFY_SCOPE],
      provider: 'google',
      credentialRevision: refreshedRevision,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ labelIds: [] }));

    await expect(service(fetchMock).mutate(command)).resolves.toMatchObject({
      outcome: 'confirmed', effect: 'changed', binding,
    });
    expect(dispatchGateEnterMock).toHaveBeenCalledWith(command, refreshed);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('sends no provider request when a refreshed credential revision is not yet authoritative', async () => {
    const refreshedRevision = '66666666-6666-4666-8666-666666666666';
    const initial = {
      connectorAccountId: target.connector_account_id,
      credentialRevision: target.credential_revision,
      providerMessageId: target.provider_message_id,
    };
    resolveTargetMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(initial);
    refreshIfExpiredMock.mockResolvedValueOnce({
      accessToken: 'refreshed-access-token',
      refreshToken: 'secret-refresh-token',
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [MODIFY_SCOPE],
      provider: 'google',
      credentialRevision: refreshedRevision,
    });
    const fetchMock = vi.fn();

    await expect(service(fetchMock).mutate(command)).resolves.toEqual({
      outcome: 'known_failure', code: 'not_admitted', compensationAvailable: false, binding,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatchGateEnterMock).not.toHaveBeenCalled();
  });

  it('sends no provider request when credential materialization fails', async () => {
    admitOnce();
    refreshIfExpiredMock.mockRejectedValueOnce(new Error('account disconnected'));
    const fetchMock = vi.fn();

    await expect(service(fetchMock).mutate(command)).resolves.toEqual({
      outcome: 'known_failure', code: 'credentials_unavailable', compensationAvailable: false, binding,
    });
    expect(resolveTargetMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatchGateEnterMock).not.toHaveBeenCalled();
  });

  it('treats an already-archived preflight as confirmed without a POST', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      id: target.provider_message_id,
      labelIds: ['STARRED'],
    }));
    admitOnce();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'confirmed', operation: 'archive', inbox: false,
      effect: 'already_in_state', compensationAvailable: false, observedAt: expect.any(String),
      binding,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('timestamps provider observation only after complete response-body acceptance', async () => {
    vi.useFakeTimers();
    try {
      const headersAt = new Date('2026-09-11T13:00:00.000Z');
      const parsedAt = new Date('2026-09-11T13:00:10.000Z');
      vi.setSystemTime(headersAt);
      let releaseBody: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseBody = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({
              id: target.provider_message_id,
              labelIds: [],
            })));
            controller.close();
          };
        },
      });
      let markFetchEntered: (() => void) | undefined;
      const fetchEntered = new Promise<void>((resolve) => { markFetchEntered = resolve; });
      const fetchMock = vi.fn().mockImplementationOnce(async () => {
        markFetchEntered?.();
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      admitOnce();

      const pending = service(fetchMock).mutate(command);
      await fetchEntered;
      vi.setSystemTime(parsedAt);
      releaseBody?.();
      const result = await pending;

      expect(result).toMatchObject({
        outcome: 'confirmed',
        observedAt: parsedAt.toISOString(),
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
      binding,
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

    expect(result).toEqual({
      outcome: 'known_failure', code: 'not_admitted', compensationAvailable: false, binding,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
    expect(dispatchGateEnterMock).not.toHaveBeenCalled();
  });

  it('awaits the durable dispatch gate after preflight and revalidation before the sole POST', async () => {
    let releaseGate: ((value: { status: 'entered' }) => void) | undefined;
    dispatchGateEnterMock.mockImplementationOnce(() => new Promise((resolve) => { releaseGate = resolve; }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ labelIds: [] }));
    admitForPost();

    const pending = service(fetchMock).mutate(command);
    await vi.waitFor(() => expect(dispatchGateEnterMock).toHaveBeenCalledTimes(1));
    expect(resolveTargetMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
    expect(dispatchGateEnterMock).toHaveBeenCalledWith(command, {
      connectorAccountId: target.connector_account_id,
      credentialRevision: target.credential_revision,
      providerMessageId: target.provider_message_id,
    });

    releaseGate?.({ status: 'entered' });
    await expect(pending).resolves.toMatchObject({ outcome: 'confirmed', effect: 'changed' });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('retains the original refusing gate when caller-owned construction options mutate in flight', async () => {
    let releaseFirst: ((value: {
      connectorAccountId: string;
      credentialRevision: string;
      providerMessageId: string;
    }) => void) | undefined;
    const resolvedTarget = {
      connectorAccountId: target.connector_account_id,
      credentialRevision: target.credential_revision,
      providerMessageId: target.provider_message_id,
    };
    resolveTargetMock
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(resolvedTarget)
      .mockResolvedValueOnce(resolvedTarget);
    const refusingGate = vi.fn().mockResolvedValue({ status: 'not_admitted' as const });
    const replacementGate = vi.fn().mockResolvedValue({ status: 'entered' as const });
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }));
    const options: GmailInboxMutationServiceOptions = {
      googleOAuthConfig: {
        clientId: 'original-client', clientSecret: '', redirectUri: 'http://localhost/original',
      },
      dispatchGate: { enter: refusingGate },
      fetch: fetchMock as unknown as (input: string, init?: RequestInit) => Promise<Response>,
      timeoutMs: 1_000,
    };
    const mutationService = new GmailInboxMutationService(options);

    const pending = mutationService.mutate(command);
    options.dispatchGate = { enter: replacementGate };
    options.googleOAuthConfig.clientId = 'replacement-client';
    options.googleOAuthConfig.redirectUri = 'https://attacker.example/callback';
    releaseFirst?.(resolvedTarget);

    await expect(pending).resolves.toEqual({
      outcome: 'known_failure', code: 'not_admitted', compensationAvailable: false, binding,
    });
    expect(refusingGate).toHaveBeenCalledWith(command, resolvedTarget);
    expect(replacementGate).not.toHaveBeenCalled();
    expect(tokenStoreConstructorMock.mock.calls[0]?.[1]).toEqual({
      clientId: 'original-client', clientSecret: '', redirectUri: 'http://localhost/original',
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  });

  it.each([
    [{ status: 'not_admitted' }, 'not_admitted'],
    [{ status: 'conflict' }, 'admission_unavailable'],
  ] as const)('maps dispatch gate $status to %s and sends no POST', async (gateResult, code) => {
    dispatchGateEnterMock.mockResolvedValueOnce(gateResult);
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }));
    admitForPost();

    await expect(service(fetchMock).mutate(command)).resolves.toEqual({
      outcome: 'known_failure', code, compensationAvailable: false, binding,
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  });

  it('maps a thrown or commit-ambiguous gate to admission_unavailable and sends no POST', async () => {
    dispatchGateEnterMock.mockRejectedValueOnce(Object.assign(new Error('commit response lost'), { code: '08006' }));
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }));
    admitForPost();

    await expect(service(fetchMock).mutate(command)).resolves.toEqual({
      outcome: 'known_failure', code: 'admission_unavailable', compensationAvailable: false, binding,
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  });

  it('classifies an unavailable pre-POST admission revalidation without dispatch', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }));
    admitOnce();
    resolveTargetMock.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'known_failure', code: 'admission_unavailable', compensationAvailable: false, binding,
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
        outcome: 'known_failure', code: 'remote_rejected', compensationAvailable: false, binding,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(dispatchGateEnterMock).not.toHaveBeenCalled();
    },
  );

  it.each([408, 429, 500, 503])(
    'maps unavailable preflight %i to a known failure without POST',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'redacted' }, status));
      admitOnce();

      const result = await service(fetchMock).mutate(command);

      expect(result).toEqual({
        outcome: 'known_failure', code: 'preflight_unavailable', compensationAvailable: false, binding,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resolveTargetMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['missing labels', { id: target.provider_message_id }],
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
      outcome: 'known_failure', code: 'preflight_unavailable', compensationAvailable: false, binding,
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
    expect(resolveTargetMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wrong id', { id: 'other-native-id', labelIds: [] }],
    ['missing id', new Response(JSON.stringify({ labelIds: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })],
    ['extra field', { id: target.provider_message_id, labelIds: [], threadId: 'extra' }],
    ['non-string label', { id: target.provider_message_id, labelIds: [1] }],
    ['too many labels', {
      id: target.provider_message_id,
      labelIds: Array.from({ length: gmailInboxMutationLimits.maxLabelIds + 1 }, () => 'x'),
    }],
    ['oversized label', {
      id: target.provider_message_id,
      labelIds: ['x'.repeat(gmailInboxMutationLimits.maxLabelIdLength + 1)],
    }],
  ])('rejects an exact-200 preflight with %s', async (_name, body) => {
    const response = body instanceof Response ? body : jsonResponse(body);
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    admitOnce();

    await expect(service(fetchMock).mutate(command)).resolves.toEqual({
      outcome: 'known_failure', code: 'preflight_unavailable', compensationAvailable: false, binding,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dispatchGateEnterMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 'text/plain', 'application/problem+json'])(
    'rejects a preflight with content type %s',
    async (contentType) => {
      const response = new Response(JSON.stringify({
        id: target.provider_message_id,
        labelIds: [],
      }), {
        status: 200,
        headers: contentType ? { 'Content-Type': contentType } : undefined,
      });
      const fetchMock = vi.fn().mockResolvedValueOnce(response);
      admitOnce();

      await expect(service(fetchMock).mutate(command)).resolves.toMatchObject({
        outcome: 'known_failure', code: 'preflight_unavailable',
      });
      expect(dispatchGateEnterMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['oversized body', new TextEncoder().encode(
      'x'.repeat(gmailInboxMutationLimits.maxResponseBytes + 1),
    )],
    ['truncated JSON', new TextEncoder().encode('{"id":')],
    ['invalid UTF-8', new Uint8Array([0xc3, 0x28])],
  ])('rejects a preflight with %s', async (_name, bytes) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    admitOnce();

    await expect(service(fetchMock).mutate(command)).resolves.toMatchObject({
      outcome: 'known_failure', code: 'preflight_unavailable',
    });
    expect(dispatchGateEnterMock).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', 'not-a-number'],
    ['negative', '-1'],
    ['oversized', String(gmailInboxMutationLimits.maxResponseBytes + 1)],
  ])('rejects and cancels a preflight with %s Content-Length', async (_name, length) => {
    const response = new Response(JSON.stringify({
      id: target.provider_message_id,
      labelIds: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Length': length },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    admitOnce();

    await expect(service(fetchMock).mutate(command)).resolves.toMatchObject({
      outcome: 'known_failure', code: 'preflight_unavailable',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispatchGateEnterMock).not.toHaveBeenCalled();
  });

  it.each(['accessor', 'revoked proxy'])(
    'contains a hostile %s response at the fetch boundary',
    async (kind) => {
      const statusGetter = vi.fn(() => { throw new Error('hostile status'); });
      const accessor = {} as Response;
      Object.defineProperty(accessor, 'status', { get: statusGetter });
      const revoked = Proxy.revocable({ status: 200 } as Response, {});
      revoked.revoke();
      const fetchMock = vi.fn().mockResolvedValueOnce(kind === 'accessor' ? accessor : revoked.proxy);
      admitOnce();

      await expect(service(fetchMock).mutate(command)).resolves.toMatchObject({
        outcome: 'known_failure', code: 'preflight_unavailable',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(dispatchGateEnterMock).not.toHaveBeenCalled();
    },
  );

  it('requires status 200 and cancels a rejected provider response body', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = { status: 201, body: { cancel } } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    admitOnce();

    await expect(service(fetchMock).mutate(command)).resolves.toMatchObject({
      outcome: 'known_failure', code: 'preflight_unavailable',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispatchGateEnterMock).not.toHaveBeenCalled();
  });

  it('keeps the timeout active while the preflight response body is streaming', async () => {
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
    admitOnce();

    await expect(service(fetchMock, 10).mutate(command)).resolves.toMatchObject({
      outcome: 'known_failure', code: 'preflight_unavailable',
    });
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    expect(dispatchGateEnterMock).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong id', jsonResponse({ id: 'other-native-id', labelIds: [] })],
    ['missing id', new Response(JSON.stringify({ labelIds: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })],
    ['missing labels', new Response(JSON.stringify({ id: target.provider_message_id }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })],
    ['extra field', jsonResponse({
      id: target.provider_message_id, labelIds: [], threadId: 'extra',
    })],
    ['invalid UTF-8', new Response(new Uint8Array([0xc3, 0x28]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })],
    ['wrong content type', new Response(JSON.stringify({
      id: target.provider_message_id, labelIds: [],
    }), { status: 200, headers: { 'Content-Type': 'text/plain' } })],
    ['oversized body', new Response(
      'x'.repeat(gmailInboxMutationLimits.maxResponseBytes + 1),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )],
  ])('does not accept a malformed POST response with %s', async (_name, postResponse) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(postResponse)
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }));
    admitForPost();

    await expect(service(fetchMock).mutate(command)).resolves.toEqual({
      outcome: 'unknown', code: 'remote_outcome_unknown', compensationAvailable: false, binding,
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'GET')).toHaveLength(2);
  });

  it('does not accept a wrong-id confirming GET after an ambiguous POST', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'redacted' }, 503))
      .mockResolvedValueOnce(jsonResponse({ id: 'other-native-id', labelIds: [] }));
    admitForPost();

    await expect(service(fetchMock).mutate(command)).resolves.toEqual({
      outcome: 'unknown', code: 'remote_outcome_unknown', compensationAvailable: false, binding,
    });
  });

  it('keeps the timeout active through a stalled POST body and performs no second POST', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    });
    let call = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      call += 1;
      if (call === 1) return Promise.resolve(jsonResponse({ labelIds: ['INBOX'] }));
      if (call === 2) {
        init?.signal?.addEventListener('abort', () => {
          streamController?.error(new DOMException('aborted', 'AbortError'));
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(jsonResponse({ labelIds: ['INBOX'] }));
    });
    admitForPost();

    await expect(service(fetchMock, 10).mutate(command)).resolves.toEqual({
      outcome: 'unknown', code: 'remote_outcome_unknown', compensationAvailable: false, binding,
    });
    expect(fetchMock.mock.calls.filter((entry) => entry[1]?.method === 'POST')).toHaveLength(1);
  });

  it('maps a deterministic mutation rejection to known failure without reconciliation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'redacted' }, 403));
    admitForPost();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'known_failure', code: 'remote_rejected', compensationAvailable: false, binding,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveTargetMock).toHaveBeenCalledTimes(3);
    expect(dispatchGateEnterMock).toHaveBeenCalledTimes(1);
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
      binding,
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
      outcome: 'unknown', code: 'remote_outcome_unknown', compensationAvailable: false, binding,
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(resolveTargetMock).toHaveBeenCalledTimes(3);
  });

  it('returns unknown for malformed mutation and reconciliation responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ labelIds: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ labelIds: 'not-an-array' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'missing-labels' }));
    admitForPost();

    const result = await service(fetchMock).mutate(command);

    expect(result).toEqual({
      outcome: 'unknown', code: 'remote_outcome_unknown', compensationAvailable: false, binding,
    });
    expect(resolveTargetMock).toHaveBeenCalledTimes(3);
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
      outcome: 'known_failure', code: 'preflight_unavailable', compensationAvailable: false, binding,
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
      binding,
    });
  });

  it('is not constructed by API, worker, or execution-router runtime code', async () => {
    const roots = [
      new URL('../../../../apps/api/', import.meta.url),
      new URL('../../../../apps/worker/', import.meta.url),
      new URL('../../../execution-router/', import.meta.url),
    ];
    const runtimeSources = (await Promise.all(roots.map(sourceFilesBelow))).flat().join('\n');
    expect(runtimeSources).not.toContain('GmailInboxMutationService');
  });
});
