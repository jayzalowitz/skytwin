import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  GmailConnector,
  normalizeSenderAddress,
  parseListId,
  type CursorStore,
  type LabelObserver,
} from '../gmail-connector.js';
import type { OAuthTokenStore } from '../oauth/token-store.js';

// ─── Helpers (mirror gmail-connector.test.ts) ─────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchHandler = (url: string) => Promise<Response> | Response;

function makeFetchRouter(routes: Record<string, FetchHandler>): typeof fetch {
  return (async (input: string | URL | { url: string }): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return handler(url);
      }
    }
    throw new Error(`Unrouted fetch: ${url}`);
  }) as typeof fetch;
}

function makeMemoryCursor(initial: Record<string, string> = {}): CursorStore {
  const store: Record<string, string> = { ...initial };
  return {
    async get(userId, provider, kind) {
      return store[`${userId}:${provider}:${kind}`] ?? null;
    },
    async save(userId, provider, kind, value) {
      store[`${userId}:${provider}:${kind}`] = value;
    },
  };
}

function makeFreshTokenStore(): OAuthTokenStore {
  const tok = { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 60_000) };
  return {
    save: async () => undefined,
    get: async () => tok,
    delete: async () => undefined,
    refreshIfExpired: async () => tok,
  } as unknown as OAuthTokenStore;
}

// ─── Pure-function helpers — these are the read/write contract that must
//      stay in sync with decision-maker.ts:normalizeSender. Issue #122. ──

describe('normalizeSenderAddress', () => {
  it('strips display name from "Name <addr>"', () => {
    expect(normalizeSenderAddress('Black Rock Rangers <rangers@blackrockrangers.org>'))
      .toBe('rangers@blackrockrangers.org');
  });

  it('lowercases the address', () => {
    expect(normalizeSenderAddress('rangers@BlackRockRangers.ORG'))
      .toBe('rangers@blackrockrangers.org');
  });

  it('returns the bare address unchanged when no angle brackets', () => {
    expect(normalizeSenderAddress('  alice@example.com  '))
      .toBe('alice@example.com');
  });

  it('returns "" for inputs without an @ (poisoning guard)', () => {
    expect(normalizeSenderAddress('not an email')).toBe('');
    expect(normalizeSenderAddress('')).toBe('');
    expect(normalizeSenderAddress('   ')).toBe('');
  });

  it('handles malformed angle brackets without throwing', () => {
    expect(normalizeSenderAddress('Name <bad>')).toBe('');
    expect(normalizeSenderAddress('<>')).toBe('');
  });
});

describe('parseListId', () => {
  it('extracts the bare identifier from an RFC-2919 List-Id header', () => {
    expect(parseListId('"Black Rock Rangers" <rangers.lists.example.org>'))
      .toBe('rangers.lists.example.org');
  });

  it('handles a bare identifier (no angle brackets)', () => {
    expect(parseListId('rangers.lists.example.org'))
      .toBe('rangers.lists.example.org');
  });

  it('returns "" for empty input', () => {
    expect(parseListId('')).toBe('');
  });

  it('lowercases the result', () => {
    expect(parseListId('<RANGERS.Lists.Example.ORG>'))
      .toBe('rangers.lists.example.org');
  });
});

// ─── Connector integration: observer is invoked per fetched message ────

describe('GmailConnector LabelObserver wiring', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records (sender, label) observations for each fetched message', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': () => jsonResponse({ messages: [{ id: 'm1' }] }),
      '/users/me/messages/m1': () => jsonResponse({
        id: 'm1',
        threadId: 't',
        labelIds: ['INBOX', 'rangers'],
        snippet: 's',
        payload: {
          headers: [
            { name: 'From', value: 'Black Rock Rangers <rangers@BlackRockRangers.org>' },
            { name: 'Subject', value: 'Routine update' },
            { name: 'List-Id', value: '<rangers.lists.example.org>' },
          ],
        },
        internalDate: '1735689600000',
        historyId: '1010',
      }),
    }));

    const recordObservations = vi.fn().mockResolvedValue(undefined);
    const observer: LabelObserver = { recordObservations };

    const conn = new GmailConnector('user-1', makeFreshTokenStore(), makeMemoryCursor(), observer);
    await conn.connect();
    await conn.poll();

    expect(recordObservations).toHaveBeenCalledTimes(1);
    expect(recordObservations).toHaveBeenCalledWith('user-1', [
      { sender: 'rangers@blackrockrangers.org', label: 'INBOX', listId: 'rangers.lists.example.org' },
      { sender: 'rangers@blackrockrangers.org', label: 'rangers', listId: 'rangers.lists.example.org' },
    ]);
  });

  it('skips recording when sender is unparseable (poisoning guard)', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': () => jsonResponse({ messages: [{ id: 'm1' }] }),
      '/users/me/messages/m1': () => jsonResponse({
        id: 'm1',
        threadId: 't',
        labelIds: ['INBOX'],
        snippet: '',
        payload: { headers: [{ name: 'From', value: 'Not An Address' }] },
        internalDate: '1735689600000',
      }),
    }));

    const recordObservations = vi.fn().mockResolvedValue(undefined);
    const conn = new GmailConnector(
      'user-1', makeFreshTokenStore(), makeMemoryCursor(), { recordObservations },
    );
    await conn.connect();
    await conn.poll();
    expect(recordObservations).not.toHaveBeenCalled();
  });

  it('skips recording when message has no labels', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': () => jsonResponse({ messages: [{ id: 'm1' }] }),
      '/users/me/messages/m1': () => jsonResponse({
        id: 'm1',
        threadId: 't',
        labelIds: [],
        snippet: '',
        payload: { headers: [{ name: 'From', value: 'a@b.com' }] },
        internalDate: '1735689600000',
      }),
    }));

    const recordObservations = vi.fn().mockResolvedValue(undefined);
    const conn = new GmailConnector(
      'user-1', makeFreshTokenStore(), makeMemoryCursor(), { recordObservations },
    );
    await conn.connect();
    await conn.poll();
    expect(recordObservations).not.toHaveBeenCalled();
  });

  it('observer errors do not stop signal emission (best-effort)', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': () => jsonResponse({ messages: [{ id: 'm1' }] }),
      '/users/me/messages/m1': () => jsonResponse({
        id: 'm1',
        threadId: 't',
        labelIds: ['rangers'],
        snippet: '',
        payload: { headers: [{ name: 'From', value: 'rangers@example.org' }] },
        internalDate: '1735689600000',
      }),
    }));

    const conn = new GmailConnector(
      'user-1',
      makeFreshTokenStore(),
      makeMemoryCursor(),
      { recordObservations: async () => { throw new Error('label DB down'); } },
    );
    await conn.connect();
    const signals = await conn.poll();
    // Observer threw, but signal still emitted — ingestion continues.
    expect(signals).toHaveLength(1);
  });

  it('plumbs listId through to the emitted signal', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': () => jsonResponse({ messages: [{ id: 'm1' }] }),
      '/users/me/messages/m1': () => jsonResponse({
        id: 'm1',
        threadId: 't',
        labelIds: ['INBOX'],
        snippet: '',
        payload: {
          headers: [
            { name: 'From', value: 'rangers@example.org' },
            { name: 'List-Id', value: '<rangers.lists.example.org>' },
          ],
        },
        internalDate: '1735689600000',
      }),
    }));

    const conn = new GmailConnector('user-1', makeFreshTokenStore(), makeMemoryCursor());
    await conn.connect();
    const signals = await conn.poll();
    const data = signals[0]!.data as { listId?: string };
    expect(data.listId).toBe('rangers.lists.example.org');
  });

  it('omits listId from the signal when the header is absent', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': () => jsonResponse({ messages: [{ id: 'm1' }] }),
      '/users/me/messages/m1': () => jsonResponse({
        id: 'm1',
        threadId: 't',
        labelIds: ['INBOX'],
        snippet: '',
        payload: { headers: [{ name: 'From', value: 'rangers@example.org' }] },
        internalDate: '1735689600000',
      }),
    }));

    const conn = new GmailConnector('user-1', makeFreshTokenStore(), makeMemoryCursor());
    await conn.connect();
    const signals = await conn.poll();
    const data = signals[0]!.data as { listId: string };
    expect(data.listId).toBe('');
  });
});
