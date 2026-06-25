import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { OutlookMailConnector } from '../outlook-mail-connector.js';
import type { CursorStore } from '../gmail-connector.js';
import type { OAuthTokenStore } from '../oauth/token-store.js';

function makeStubStore(token: { accessToken: string; refreshToken: string; expiresAt: Date } | null): OAuthTokenStore {
  return {
    save: async () => undefined,
    get: async () => token,
    delete: async () => undefined,
    refreshIfExpired: async () => {
      if (!token) throw new Error('No token stored');
      return token;
    },
  } as unknown as OAuthTokenStore;
}

const VALID_TOKEN = { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 60_000) };

/** In-memory CursorStore (a Map keyed on user|provider|kind). */
function makeCursorStore(seed?: { key: string; value: string }): CursorStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  if (seed) map.set(seed.key, seed.value);
  return {
    map,
    get: async (u, p, k) => map.get(`${u}|${p}|${k}`) ?? null,
    save: async (u, p, k, v) => void map.set(`${u}|${p}|${k}`, v),
  };
}
const CURSOR_KEY = 'user-1|outlook|delta_link';

interface GMsgOver {
  id?: string;
  subject?: string;
  from?: { emailAddress: { name?: string; address?: string } };
  headers?: Array<{ name: string; value: string }>;
}
function gmsg(over: GMsgOver = {}): unknown {
  return {
    id: over.id ?? 'm1',
    conversationId: 'c1',
    subject: over.subject ?? 'Hello there',
    bodyPreview: 'preview text',
    from: over.from ?? { emailAddress: { name: 'Sender', address: 'sender@example.com' } },
    toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
    ccRecipients: [],
    receivedDateTime: '2026-06-20T10:00:00Z',
    isRead: false,
    internetMessageHeaders: over.headers ?? [],
  };
}
function res(status: number, body: unknown, headers: Record<string, string> = {}): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (k: string) => headers[k] ?? null },
  };
}

const fetchMock = vi.fn();

async function connected(cursor?: CursorStore): Promise<OutlookMailConnector> {
  const conn = new OutlookMailConnector('user-1', makeStubStore(VALID_TOKEN), cursor ?? null);
  await conn.connect();
  return conn;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('OutlookMailConnector', () => {
  it('connect() throws when no Microsoft token is available', async () => {
    const conn = new OutlookMailConnector('user-1', makeStubStore(null));
    await expect(conn.connect()).rejects.toThrow();
  });

  it('bootstraps from a fresh inbox delta and emits one signal per message', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, { value: [gmsg({ id: 'a' }), gmsg({ id: 'b' })], '@odata.deltaLink': 'DELTA1' }),
    );
    const cursor = makeCursorStore();
    const conn = await connected(cursor);

    const handlerHits: string[] = [];
    conn.onSignal((s) => handlerHits.push(s.id));

    const signals = await conn.poll();

    // First request hits the inbox delta endpoint.
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/me/mailFolders/inbox/messages/delta');

    expect(signals.map((s) => s.id)).toEqual(['sig_outlook_a', 'sig_outlook_b']);
    expect(signals[0]!.source).toBe('outlook');
    expect(signals[0]!.data.messageId).toBe('a');
    expect(signals[0]!.data.authoringTier).toBeDefined();
    expect(handlerHits).toEqual(['sig_outlook_a', 'sig_outlook_b']);
    // The deltaLink is persisted for the next poll.
    expect(cursor.map.get(CURSOR_KEY)).toBe('DELTA1');
  });

  it('stamps an inbound authoring tier (never user_sent) on inbox mail', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, {
        value: [gmsg({ id: 'n', headers: [{ name: 'List-Unsubscribe', value: '<mailto:x@list>' }] })],
        '@odata.deltaLink': 'D',
      }),
    );
    const conn = await connected();
    const [sig] = await conn.poll();
    expect(['inbox_personal', 'inbox_broadcast', 'inbox_newsletter', 'inbox_automated']).toContain(
      sig!.data.authoringTier,
    );
  });

  it('drains paginated delta (nextLink → deltaLink) in one poll and stores the deltaLink', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { value: [gmsg({ id: 'a' })], '@odata.nextLink': 'NEXT1' }))
      .mockResolvedValueOnce(res(200, { value: [gmsg({ id: 'b' })], '@odata.deltaLink': 'DELTA2' }));
    const cursor = makeCursorStore();
    const conn = await connected(cursor);

    const signals = await conn.poll();
    expect(signals.map((s) => s.data.messageId)).toEqual(['a', 'b']);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe('NEXT1');
    expect(cursor.map.get(CURSOR_KEY)).toBe('DELTA2');
  });

  it('follows a stored deltaLink incrementally', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { value: [gmsg({ id: 'c' })], '@odata.deltaLink': 'DELTA3' }));
    const cursor = makeCursorStore({ key: CURSOR_KEY, value: 'STORED_DELTA' });
    const conn = await connected(cursor);

    const signals = await conn.poll();
    // First request is the stored deltaLink, not a fresh bootstrap.
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('STORED_DELTA');
    expect(signals.map((s) => s.data.messageId)).toEqual(['c']);
    expect(cursor.map.get(CURSOR_KEY)).toBe('DELTA3');
  });

  it('re-bootstraps on a 410 Gone (expired delta link)', async () => {
    fetchMock
      .mockResolvedValueOnce(res(410, {})) // stored deltaLink expired
      .mockResolvedValueOnce(res(200, { value: [gmsg({ id: 'd' })], '@odata.deltaLink': 'DELTA4' }));
    const cursor = makeCursorStore({ key: CURSOR_KEY, value: 'STALE_DELTA' });
    const conn = await connected(cursor);

    const signals = await conn.poll();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('STALE_DELTA');
    // Second call is a FRESH delta bootstrap, not the stale link again.
    expect((fetchMock.mock.calls[1] as [string])[0]).toContain('/me/mailFolders/inbox/messages/delta');
    expect(signals.map((s) => s.data.messageId)).toEqual(['d']);
    expect(cursor.map.get(CURSOR_KEY)).toBe('DELTA4');
  });

  it('skips delta tombstones (@removed deletions) and messages with no receivedDateTime', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, {
        value: [
          gmsg({ id: 'real' }),
          { id: 'deleted', '@removed': { reason: 'deleted' } }, // tombstone — has an id but no body
          { id: 'no-date', subject: 'partial' }, // missing receivedDateTime
        ],
        '@odata.deltaLink': 'D',
      }),
    );
    const conn = await connected();
    const signals = await conn.poll();
    // Only the real message becomes a signal — not the deletion, not the dateless one.
    expect(signals.map((s) => s.data.messageId)).toEqual(['real']);
  });

  it('caps pages per poll and persists the last nextLink to resume next time', async () => {
    for (let i = 1; i <= 6; i++) {
      fetchMock.mockResolvedValueOnce(res(200, { value: [gmsg({ id: `p${i}` })], '@odata.nextLink': `NEXT${i}` }));
    }
    const cursor = makeCursorStore();
    const conn = await connected(cursor);
    const signals = await conn.poll();
    // MAX_PAGES_PER_POLL is 5 → 5 fetches, 5 signals, cursor at the 5th nextLink.
    expect(fetchMock.mock.calls.length).toBe(5);
    expect(signals).toHaveLength(5);
    expect(cursor.map.get(CURSOR_KEY)).toBe('NEXT5');
  });

  it('on a 410 mid-sync (after pages already emitted) returns partial WITHOUT double-emitting', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { value: [gmsg({ id: 'a' })], '@odata.nextLink': 'NEXT1' }))
      .mockResolvedValueOnce(res(410, {})); // the next page's link expired mid-sync
    const cursor = makeCursorStore();
    const conn = await connected(cursor);
    const hits: string[] = [];
    conn.onSignal((s) => hits.push(s.id));

    const signals = await conn.poll();
    // 'a' was emitted once; the 410 stops the drain rather than restarting +
    // re-emitting it. The cursor advanced to NEXT1 so the next poll resumes.
    expect(signals.map((s) => s.data.messageId)).toEqual(['a']);
    expect(hits).toEqual(['sig_outlook_a']); // exactly once — no double-fire
    expect(cursor.map.get(CURSOR_KEY)).toBe('NEXT1');
  });

  it('poll() throws before connect()', async () => {
    const conn = new OutlookMailConnector('user-1', makeStubStore(VALID_TOKEN));
    await expect(conn.poll()).rejects.toThrow(/not connected/);
  });
});
