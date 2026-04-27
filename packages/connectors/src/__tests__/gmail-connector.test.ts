import { describe, it, expect } from 'vitest';
import { GmailConnector } from '../gmail-connector.js';
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
});
