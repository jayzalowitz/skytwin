import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { GmailConnector, type CursorStore } from '../gmail-connector.js';
import type { OAuthTokenStore } from '../oauth/token-store.js';

function makeStubStore(token: { accessToken: string; refreshToken: string; expiresAt: Date } | null): OAuthTokenStore {
  return {
    save: async () => undefined,
    get: async () => token,
    delete: async () => undefined,
    refreshIfExpired: async () => {
      if (!token) {
        throw new Error('No token stored');
      }
      return token;
    },
  } as unknown as OAuthTokenStore;
}

function makeMessage(overrides: {
  id?: string;
  from?: string;
  subject?: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
} = {}): unknown {
  return {
    id: overrides.id ?? 'm1',
    threadId: 'thread-1',
    labelIds: overrides.labelIds ?? [],
    snippet: overrides.snippet ?? 'preview text',
    payload: {
      headers: [
        { name: 'From', value: overrides.from ?? 'sender@example.com' },
        { name: 'Subject', value: overrides.subject ?? '' },
        { name: 'Date', value: 'Mon, 1 Jan 2026 00:00:00 GMT' },
      ],
    },
    internalDate: overrides.internalDate ?? '1735689600000',
  };
}

describe('GmailConnector lifecycle', () => {
  it('connect() throws when no token is available', async () => {
    const conn = new GmailConnector('user-1', makeStubStore(null));
    await expect(conn.connect()).rejects.toThrow();
  });

  it('connect() succeeds when a token is available', async () => {
    const store = makeStubStore({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GmailConnector('user-1', store);
    await expect(conn.connect()).resolves.toBeUndefined();
  });

  it('poll() throws if connect() was not called', async () => {
    const store = makeStubStore({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GmailConnector('user-1', store);
    await expect(conn.poll()).rejects.toThrow(/not connected/);
  });

  it('disconnect() clears handler list and connection state', async () => {
    const store = makeStubStore({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GmailConnector('user-1', store);
    await conn.connect();
    conn.onSignal(() => {});
    await conn.disconnect();
    // After disconnect, poll should throw "not connected" again
    await expect(conn.poll()).rejects.toThrow(/not connected/);
  });
});

describe('GmailConnector.inferEmailType', () => {
  // Private method — accessed via cast for test coverage of the classification.
  function infer(from: string, subject: string, labels: string[] = []): string {
    const conn = new GmailConnector('u', makeStubStore(null));
    return (conn as unknown as { inferEmailType: (f: string, s: string, l: string[]) => string })
      .inferEmailType(from, subject, labels);
  }

  it('classifies CATEGORY_PROMOTIONS as newsletter', () => {
    expect(infer('any@x.com', '', ['CATEGORY_PROMOTIONS'])).toBe('newsletter');
  });

  it('classifies "newsletter" or "digest" subjects as newsletter', () => {
    expect(infer('a@x.com', 'Weekly Newsletter')).toBe('newsletter');
    expect(infer('a@x.com', 'Daily Digest')).toBe('newsletter');
  });

  it('classifies subscription/renewal/billing subjects', () => {
    expect(infer('a@x.com', 'Your subscription is renewing')).toBe('subscription_renewal');
    expect(infer('a@x.com', 'Billing notice')).toBe('subscription_renewal');
  });

  it('classifies meeting subjects as meeting_invite', () => {
    expect(infer('a@x.com', 'Meeting on Friday')).toBe('meeting_invite');
    expect(infer('a@x.com', 'Calendar invite')).toBe('meeting_invite');
  });

  it('classifies grocery/order subjects as grocery_reorder', () => {
    expect(infer('a@x.com', 'Your order has shipped')).toBe('grocery_reorder');
    expect(infer('a@x.com', 'Grocery delivery tomorrow')).toBe('grocery_reorder');
  });

  it('classifies travel-related subjects as travel_alert', () => {
    expect(infer('a@x.com', 'Flight confirmation')).toBe('travel_alert');
    expect(infer('a@x.com', 'Hotel booking')).toBe('travel_alert');
  });

  it('classifies noreply senders as notification', () => {
    expect(infer('noreply@stripe.com', 'Receipt')).toBe('notification');
    expect(infer('no-reply@github.com', 'Pull request')).toBe('notification');
  });

  it('classifies CATEGORY_UPDATES as notification', () => {
    expect(infer('person@example.com', 'Update', ['CATEGORY_UPDATES'])).toBe('notification');
  });

  it('falls back to work_email for unmatched mail', () => {
    expect(infer('client@company.com', 'Quick question about the contract')).toBe('work_email');
  });

  it('case-insensitive matching on subject and sender', () => {
    expect(infer('a@x.com', 'NEWSLETTER FROM US')).toBe('newsletter');
    expect(infer('NoReply@example.com', 'Hi')).toBe('notification');
  });
});

describe('GmailConnector.messageToSignal', () => {
  function toSignal(msg: unknown): unknown {
    const conn = new GmailConnector('u', makeStubStore(null));
    return (conn as unknown as { messageToSignal: (m: unknown) => unknown }).messageToSignal(msg);
  }

  it('produces a stable id prefix and source', () => {
    const sig = toSignal(makeMessage({ id: 'abc' })) as { id: string; source: string };
    expect(sig.id).toBe('sig_gmail_abc');
    expect(sig.source).toBe('gmail');
  });

  it('extracts From and Subject case-insensitively', () => {
    const msg = {
      id: 'm1',
      threadId: 't1',
      labelIds: [],
      snippet: '',
      payload: {
        headers: [
          { name: 'from', value: 'lower@example.com' },
          { name: 'SUBJECT', value: 'Mixed case header' },
        ],
      },
      internalDate: '1735689600000',
    };
    const sig = toSignal(msg) as { data: { from: string; subject: string } };
    expect(sig.data.from).toBe('lower@example.com');
    expect(sig.data.subject).toBe('Mixed case header');
  });

  it('marks work_email and meeting_invite as requiresResponse', () => {
    const work = toSignal(makeMessage({ subject: 'Quick question' })) as { data: { requiresResponse: boolean } };
    const meeting = toSignal(makeMessage({ subject: 'Meeting on Friday' })) as { data: { requiresResponse: boolean } };
    expect(work.data.requiresResponse).toBe(true);
    expect(meeting.data.requiresResponse).toBe(true);
  });

  it('does not mark newsletters or notifications as requiresResponse', () => {
    const news = toSignal(makeMessage({ subject: 'Weekly Newsletter' })) as { data: { requiresResponse: boolean } };
    const noti = toSignal(makeMessage({ from: 'noreply@x.com', subject: 'Receipt' })) as { data: { requiresResponse: boolean } };
    expect(news.data.requiresResponse).toBe(false);
    expect(noti.data.requiresResponse).toBe(false);
  });

  it('parses internalDate (epoch ms) into ISO timestamp', () => {
    const sig = toSignal(makeMessage({ internalDate: '1735689600000' })) as {
      data: { receivedAt: string };
      timestamp: Date;
    };
    expect(sig.data.receivedAt).toBe(new Date(1735689600000).toISOString());
    expect(sig.timestamp).toBeInstanceOf(Date);
  });

  it('handles missing headers without throwing', () => {
    const msg = {
      id: 'm1',
      threadId: 't1',
      labelIds: [],
      snippet: '',
      payload: { headers: [] },
      internalDate: '1735689600000',
    };
    const sig = toSignal(msg) as { data: { from: string; subject: string } };
    expect(sig.data.from).toBe('');
    expect(sig.data.subject).toBe('');
  });

  // #251 Layer 1: messageToSignal stamps `data.authoringTier` so downstream
  // memory writers can project it onto brain_pages.metadata without re-
  // reading raw Gmail headers.
  it('stamps authoringTier=user_sent_originated for SENT mail with no In-Reply-To', () => {
    const msg = {
      id: 'm-sent',
      threadId: 't-sent',
      labelIds: ['SENT'],
      snippet: '',
      payload: {
        headers: [
          { name: 'From', value: 'me@example.com' },
          { name: 'To', value: 'friend@example.com' },
        ],
      },
      internalDate: '1735689600000',
    };
    const sig = toSignal(msg) as { data: { authoringTier: string } };
    expect(sig.data.authoringTier).toBe('user_sent_originated');
  });

  it('stamps authoringTier=user_sent_reply when In-Reply-To is present', () => {
    const msg = {
      id: 'm-sent-reply',
      threadId: 't-sent-reply',
      labelIds: ['SENT'],
      snippet: '',
      payload: {
        headers: [
          { name: 'From', value: 'me@example.com' },
          { name: 'To', value: 'friend@example.com' },
          { name: 'In-Reply-To', value: '<original-id@mail.example.com>' },
        ],
      },
      internalDate: '1735689600000',
    };
    const sig = toSignal(msg) as { data: { authoringTier: string } };
    expect(sig.data.authoringTier).toBe('user_sent_reply');
  });

  it('stamps authoringTier=inbox_newsletter when List-Unsubscribe is present', () => {
    const msg = {
      id: 'm-news',
      threadId: 't-news',
      labelIds: ['INBOX'],
      snippet: '',
      payload: {
        headers: [
          { name: 'From', value: 'updates@vendor.com' },
          { name: 'List-Unsubscribe', value: '<mailto:unsubscribe@vendor.com>' },
        ],
      },
      internalDate: '1735689600000',
    };
    const sig = toSignal(msg) as { data: { authoringTier: string } };
    expect(sig.data.authoringTier).toBe('inbox_newsletter');
  });

  it('stamps authoringTier=inbox_automated for noreply senders without list semantics', () => {
    const msg = {
      id: 'm-auto',
      threadId: 't-auto',
      labelIds: ['INBOX'],
      snippet: '',
      payload: {
        headers: [
          { name: 'From', value: 'noreply@stripe.com' },
          { name: 'To', value: 'me@example.com' },
        ],
      },
      internalDate: '1735689600000',
    };
    const sig = toSignal(msg) as { data: { authoringTier: string } };
    expect(sig.data.authoringTier).toBe('inbox_automated');
  });

  it('stamps authoringTier=inbox_broadcast when To has multiple recipients', () => {
    const msg = {
      id: 'm-bcast',
      threadId: 't-bcast',
      labelIds: ['INBOX'],
      snippet: '',
      payload: {
        headers: [
          { name: 'From', value: 'leader@example.com' },
          { name: 'To', value: 'me@example.com, other@example.com' },
        ],
      },
      internalDate: '1735689600000',
    };
    const sig = toSignal(msg) as { data: { authoringTier: string } };
    expect(sig.data.authoringTier).toBe('inbox_broadcast');
  });

  it('defaults inbox single-recipient mail to authoringTier=inbox_personal', () => {
    const msg = {
      id: 'm-personal',
      threadId: 't-personal',
      labelIds: ['INBOX'],
      snippet: '',
      payload: {
        headers: [
          { name: 'From', value: 'friend@example.com' },
          { name: 'To', value: 'me@example.com' },
        ],
      },
      internalDate: '1735689600000',
    };
    const sig = toSignal(msg) as { data: { authoringTier: string } };
    expect(sig.data.authoringTier).toBe('inbox_personal');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Gmail History API integration — uses stubbed fetch responses.
// ─────────────────────────────────────────────────────────────────────────

type FetchHandler = (url: string) => Promise<Response> | Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

function makeMemoryCursor(initial: Record<string, string> = {}): CursorStore & { snapshot: Record<string, string> } {
  const store: Record<string, string> = { ...initial };
  return {
    snapshot: store,
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

describe('GmailConnector History API', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bootstrap (no cursor) lists recent unread, emits signals, and persists historyId', async () => {
    const detailFor = (id: string, hist: string) =>
      jsonResponse({
        id,
        threadId: `t-${id}`,
        labelIds: ['INBOX'],
        snippet: `s-${id}`,
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'Subject', value: `subject ${id}` },
          ],
        },
        internalDate: '1735689600000',
        historyId: hist,
      });

    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': () => jsonResponse({ messages: [{ id: 'm1' }, { id: 'm2' }] }),
      '/users/me/messages/m1': () => detailFor('m1', '1010'),
      '/users/me/messages/m2': () => detailFor('m2', '1020'),
    }));

    const cursor = makeMemoryCursor();
    const conn = new GmailConnector('user-1', makeFreshTokenStore(), cursor);
    await conn.connect();
    const signals = await conn.poll();

    expect(signals).toHaveLength(2);
    expect(signals[0]!.id).toBe('sig_gmail_m1');
    expect(signals[1]!.id).toBe('sig_gmail_m2');
    // Highest historyId observed becomes the persisted cursor.
    expect(cursor.snapshot['user-1:gmail:history_id']).toBe('1020');
  });

  it('bootstrap with empty inbox falls back to /users/me/profile for the cursor', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': () => jsonResponse({ messages: [] }),
      '/users/me/profile': () => jsonResponse({ historyId: '99' }),
    }));

    const cursor = makeMemoryCursor();
    const conn = new GmailConnector('user-1', makeFreshTokenStore(), cursor);
    await conn.connect();
    const signals = await conn.poll();

    expect(signals).toHaveLength(0);
    expect(cursor.snapshot['user-1:gmail:history_id']).toBe('99');
  });

  it('subsequent poll uses history.list with stored startHistoryId and emits only added messages', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/history': (url) => {
        calls.push(url);
        return jsonResponse({
          history: [
            { messagesAdded: [{ message: { id: 'new-1' } }] },
            { messagesAdded: [{ message: { id: 'new-2' } }] },
          ],
          historyId: '2050',
        });
      },
      '/users/me/messages/new-1': () => jsonResponse({
        id: 'new-1',
        threadId: 't-new-1',
        labelIds: [],
        snippet: '',
        payload: { headers: [] },
        internalDate: '1735689600000',
        historyId: '2030',
      }),
      '/users/me/messages/new-2': () => jsonResponse({
        id: 'new-2',
        threadId: 't-new-2',
        labelIds: [],
        snippet: '',
        payload: { headers: [] },
        internalDate: '1735689600000',
        historyId: '2040',
      }),
    }));

    const cursor = makeMemoryCursor({ 'user-1:gmail:history_id': '1000' });
    const conn = new GmailConnector('user-1', makeFreshTokenStore(), cursor);
    await conn.connect();
    const signals = await conn.poll();

    expect(signals).toHaveLength(2);
    expect(signals[0]!.id).toBe('sig_gmail_new-1');
    expect(calls[0]).toContain('startHistoryId=1000');
    expect(calls[0]).toContain('historyTypes=messageAdded');
    // Cursor advances to the response's historyId (which is the highest observed).
    expect(cursor.snapshot['user-1:gmail:history_id']).toBe('2050');
  });

  it('subsequent poll with no new messages still advances the cursor to the response historyId', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/history': () => jsonResponse({ historyId: '5500' }),
    }));

    const cursor = makeMemoryCursor({ 'user-1:gmail:history_id': '5400' });
    const conn = new GmailConnector('user-1', makeFreshTokenStore(), cursor);
    await conn.connect();
    const signals = await conn.poll();

    expect(signals).toHaveLength(0);
    expect(cursor.snapshot['user-1:gmail:history_id']).toBe('5500');
  });

  it('history.list 404 (cursor expired) re-bootstraps from a fresh listing', async () => {
    let historyHits = 0;
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/history': () => {
        historyHits++;
        return new Response('history too old', { status: 404 });
      },
      '/users/me/messages?q=': () => jsonResponse({ messages: [{ id: 'fresh' }] }),
      '/users/me/messages/fresh': () => jsonResponse({
        id: 'fresh',
        threadId: 't-fresh',
        labelIds: [],
        snippet: '',
        payload: { headers: [] },
        internalDate: '1735689600000',
        historyId: '9999',
      }),
    }));

    const cursor = makeMemoryCursor({ 'user-1:gmail:history_id': '1' });
    const conn = new GmailConnector('user-1', makeFreshTokenStore(), cursor);
    await conn.connect();
    const signals = await conn.poll();

    expect(historyHits).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.id).toBe('sig_gmail_fresh');
    expect(cursor.snapshot['user-1:gmail:history_id']).toBe('9999');
  });

  it('cursor save errors do not crash the poll', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': () => jsonResponse({ messages: [] }),
      '/users/me/profile': () => jsonResponse({ historyId: '500' }),
    }));

    const failingCursor: CursorStore = {
      get: async () => null,
      save: async () => {
        throw new Error('DB down');
      },
    };

    const conn = new GmailConnector('user-1', makeFreshTokenStore(), failingCursor);
    await conn.connect();
    await expect(conn.poll()).resolves.toEqual([]);
  });

  it('without a cursor store, the connector still works (back-compat)', async () => {
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': () => jsonResponse({ messages: [] }),
      '/users/me/profile': () => jsonResponse({ historyId: '7' }),
    }));
    const conn = new GmailConnector('user-1', makeFreshTokenStore());
    await conn.connect();
    await expect(conn.poll()).resolves.toEqual([]);
  });

  // #251 Layer 3 (minimal): bootstrap emits sent mail FIRST so the user's
  // first-impression brain pages lead with things they wrote rather than
  // whatever happened to be unread. Layer 1 above stamps the tier; this
  // test verifies the ordering side of the contract.
  it('bootstrap emits in:sent results before is:unread, deduped by id', async () => {
    const listCalls: string[] = [];
    vi.stubGlobal('fetch', makeFetchRouter({
      '/users/me/messages?q=': (url) => {
        listCalls.push(url);
        if (url.includes('in%3Asent')) {
          return jsonResponse({ messages: [{ id: 'sent-1' }, { id: 'shared' }] });
        }
        // is:unread branch
        return jsonResponse({ messages: [{ id: 'shared' }, { id: 'unread-1' }] });
      },
      '/users/me/messages/sent-1': () => jsonResponse({
        id: 'sent-1',
        threadId: 't-sent-1',
        labelIds: ['SENT'],
        snippet: '',
        payload: { headers: [{ name: 'From', value: 'me@example.com' }] },
        internalDate: '1735689600000',
        historyId: '1100',
      }),
      '/users/me/messages/shared': () => jsonResponse({
        id: 'shared',
        threadId: 't-shared',
        labelIds: ['SENT', 'INBOX'],
        snippet: '',
        payload: { headers: [{ name: 'From', value: 'me@example.com' }] },
        internalDate: '1735689600000',
        historyId: '1200',
      }),
      '/users/me/messages/unread-1': () => jsonResponse({
        id: 'unread-1',
        threadId: 't-unread-1',
        labelIds: ['INBOX'],
        snippet: '',
        payload: { headers: [{ name: 'From', value: 'friend@example.com' }] },
        internalDate: '1735689600000',
        historyId: '1300',
      }),
    }));

    const cursor = makeMemoryCursor();
    const conn = new GmailConnector('user-1', makeFreshTokenStore(), cursor);
    await conn.connect();
    const signals = await conn.poll();

    // Both list queries hit (sent-first), and unread is fetched even though
    // the sent list already covered one of its ids.
    expect(listCalls.length).toBe(2);
    expect(listCalls[0]).toContain('in%3Asent');
    expect(listCalls[1]).toContain('is%3Aunread');

    // Sent ids appear first; shared id is deduped to its sent-list position;
    // unread-only id appears last.
    expect(signals.map((s) => s.id)).toEqual([
      'sig_gmail_sent-1',
      'sig_gmail_shared',
      'sig_gmail_unread-1',
    ]);

    // Highest historyId observed across all three messages wins the cursor.
    expect(cursor.snapshot['user-1:gmail:history_id']).toBe('1300');
  });
});
