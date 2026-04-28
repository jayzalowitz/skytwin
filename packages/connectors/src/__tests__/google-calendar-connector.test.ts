import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { GoogleCalendarConnector } from '../google-calendar-connector.js';
import type { CursorStore } from '../gmail-connector.js';
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

interface RawCalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  organizer: { email: string; displayName?: string };
  attendees?: Array<{ email: string; responseStatus: string; self?: boolean }>;
  status: string;
  htmlLink: string;
  created: string;
  updated: string;
}

function makeEvent(overrides: Partial<RawCalendarEvent> = {}): RawCalendarEvent {
  return {
    id: overrides.id ?? 'evt-1',
    summary: overrides.summary ?? 'Standup',
    start: overrides.start ?? { dateTime: '2026-04-27T09:00:00Z' },
    end: overrides.end ?? { dateTime: '2026-04-27T09:30:00Z' },
    organizer: overrides.organizer ?? { email: 'host@example.com' },
    attendees: overrides.attendees,
    status: overrides.status ?? 'confirmed',
    htmlLink: overrides.htmlLink ?? 'https://calendar.google.com/event?eid=x',
    created: overrides.created ?? '2026-04-26T00:00:00Z',
    updated: overrides.updated ?? '2026-04-26T00:00:00Z',
    description: overrides.description,
  };
}

describe('GoogleCalendarConnector lifecycle', () => {
  it('connect() throws when no token is available', async () => {
    const conn = new GoogleCalendarConnector('user-1', makeStubStore(null));
    await expect(conn.connect()).rejects.toThrow();
  });

  it('connect() succeeds with a valid token', async () => {
    const store = makeStubStore({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GoogleCalendarConnector('user-1', store);
    await expect(conn.connect()).resolves.toBeUndefined();
  });

  it('poll() throws when not connected', async () => {
    const store = makeStubStore({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GoogleCalendarConnector('user-1', store);
    await expect(conn.poll()).rejects.toThrow(/not connected/);
  });

  it('disconnect() clears state and handlers', async () => {
    const store = makeStubStore({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GoogleCalendarConnector('user-1', store);
    await conn.connect();
    await conn.disconnect();
    await expect(conn.poll()).rejects.toThrow(/not connected/);
  });
});

describe('GoogleCalendarConnector.eventToSignal', () => {
  function toSignal(event: RawCalendarEvent, hasConflict = false): unknown {
    const conn = new GoogleCalendarConnector('u', makeStubStore(null));
    return (conn as unknown as { eventToSignal: (e: RawCalendarEvent, c: boolean) => unknown })
      .eventToSignal(event, hasConflict);
  }

  it('produces a stable id derived from event id and updated timestamp', () => {
    const sig = toSignal(makeEvent({ id: 'abc', updated: '2026-04-26T12:34:56Z' })) as { id: string; source: string };
    expect(sig.id).toContain('sig_cal_abc');
    expect(sig.source).toBe('google_calendar');
  });

  it('marks needsAction self-attendee as meeting_invite + requiresResponse', () => {
    const event = makeEvent({
      attendees: [{ email: 'me@x.com', responseStatus: 'needsAction', self: true }],
    });
    const sig = toSignal(event) as { type: string; data: { requiresResponse: boolean; responseStatus: string } };
    expect(sig.type).toBe('meeting_invite');
    expect(sig.data.requiresResponse).toBe(true);
    expect(sig.data.responseStatus).toBe('needsAction');
  });

  it('marks accepted self-attendee as calendar_event (no response needed)', () => {
    const event = makeEvent({
      attendees: [{ email: 'me@x.com', responseStatus: 'accepted', self: true }],
    });
    const sig = toSignal(event) as { type: string; data: { requiresResponse: boolean } };
    expect(sig.type).toBe('calendar_event');
    expect(sig.data.requiresResponse).toBe(false);
  });

  it('treats events without self attendee as calendar_event', () => {
    const event = makeEvent({
      attendees: [{ email: 'someone@x.com', responseStatus: 'accepted' }],
    });
    const sig = toSignal(event) as { type: string; data: { responseStatus: string } };
    expect(sig.type).toBe('calendar_event');
    expect(sig.data.responseStatus).toBe('unknown');
  });

  it('surfaces the conflict flag in payload', () => {
    const sig = toSignal(makeEvent(), true) as { data: { hasConflict: boolean } };
    expect(sig.data.hasConflict).toBe(true);
  });

  it('handles all-day events (date instead of dateTime)', () => {
    const event = makeEvent({
      start: { date: '2026-04-27' },
      end: { date: '2026-04-28' },
    });
    const sig = toSignal(event) as { data: { startTime: string; endTime: string } };
    expect(sig.data.startTime).toBe('2026-04-27');
    expect(sig.data.endTime).toBe('2026-04-28');
  });
});

describe('GoogleCalendarConnector.detectConflicts', () => {
  function detect(events: RawCalendarEvent[]): Set<string> {
    const conn = new GoogleCalendarConnector('u', makeStubStore(null));
    return (conn as unknown as { detectConflicts: (e: RawCalendarEvent[]) => Set<string> })
      .detectConflicts(events);
  }

  it('returns empty set when no events overlap', () => {
    const events = [
      makeEvent({ id: 'a', start: { dateTime: '2026-04-27T09:00:00Z' }, end: { dateTime: '2026-04-27T10:00:00Z' } }),
      makeEvent({ id: 'b', start: { dateTime: '2026-04-27T10:30:00Z' }, end: { dateTime: '2026-04-27T11:00:00Z' } }),
    ];
    expect(detect(events).size).toBe(0);
  });

  it('flags both events when they overlap', () => {
    const events = [
      makeEvent({ id: 'a', start: { dateTime: '2026-04-27T09:00:00Z' }, end: { dateTime: '2026-04-27T10:00:00Z' } }),
      makeEvent({ id: 'b', start: { dateTime: '2026-04-27T09:30:00Z' }, end: { dateTime: '2026-04-27T10:30:00Z' } }),
    ];
    const conflicts = detect(events);
    expect(conflicts.has('a')).toBe(true);
    expect(conflicts.has('b')).toBe(true);
  });

  it('does not flag back-to-back events sharing a boundary', () => {
    // a ends at 10:00, b starts at 10:00 → not a conflict
    const events = [
      makeEvent({ id: 'a', start: { dateTime: '2026-04-27T09:00:00Z' }, end: { dateTime: '2026-04-27T10:00:00Z' } }),
      makeEvent({ id: 'b', start: { dateTime: '2026-04-27T10:00:00Z' }, end: { dateTime: '2026-04-27T11:00:00Z' } }),
    ];
    expect(detect(events).size).toBe(0);
  });

  it('flags all events in a three-way overlap', () => {
    const events = [
      makeEvent({ id: 'a', start: { dateTime: '2026-04-27T09:00:00Z' }, end: { dateTime: '2026-04-27T11:00:00Z' } }),
      makeEvent({ id: 'b', start: { dateTime: '2026-04-27T10:00:00Z' }, end: { dateTime: '2026-04-27T10:30:00Z' } }),
      makeEvent({ id: 'c', start: { dateTime: '2026-04-27T10:15:00Z' }, end: { dateTime: '2026-04-27T11:00:00Z' } }),
    ];
    const conflicts = detect(events);
    expect(conflicts.has('a')).toBe(true);
    expect(conflicts.has('b')).toBe(true);
    expect(conflicts.has('c')).toBe(true);
  });

  it('ignores events without dateTime (all-day events)', () => {
    const events = [
      makeEvent({ id: 'a', start: { dateTime: '2026-04-27T09:00:00Z' }, end: { dateTime: '2026-04-27T10:00:00Z' } }),
      makeEvent({ id: 'allday', start: { date: '2026-04-27' }, end: { date: '2026-04-28' } }),
    ];
    const conflicts = detect(events);
    // Only a is dateTime; allday is ignored — no overlap detected
    expect(conflicts.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Persistent syncToken — survives worker restarts
// ─────────────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function memoryCursor(initial: Record<string, string> = {}): CursorStore & { snapshot: Record<string, string> } {
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

describe('GoogleCalendarConnector syncToken persistence', () => {
  let lastUrl = '';
  beforeEach(() => {
    lastUrl = '';
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('on first poll uses timeMin/timeMax (no syncToken) and persists nextSyncToken', async () => {
    vi.stubGlobal('fetch', (async (input: string | URL | { url: string }): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      lastUrl = url;
      return jsonResponse({
        items: [makeEvent({ id: 'evt-init' })],
        nextSyncToken: 'sync-token-1',
      });
    }) as typeof fetch);

    const cursor = memoryCursor();
    const tokenStore = makeStubStore({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GoogleCalendarConnector('user-1', tokenStore, cursor);
    await conn.connect();
    const signals = await conn.poll();

    expect(signals).toHaveLength(1);
    expect(lastUrl).toContain('timeMin=');
    expect(lastUrl).toContain('timeMax=');
    expect(lastUrl).not.toContain('syncToken=');
    expect(cursor.snapshot['user-1:google_calendar:sync_token']).toBe('sync-token-1');
  });

  it('subsequent poll loads stored syncToken and sends it on the request', async () => {
    vi.stubGlobal('fetch', (async (input: string | URL | { url: string }): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      lastUrl = url;
      return jsonResponse({
        items: [],
        nextSyncToken: 'sync-token-2',
      });
    }) as typeof fetch);

    const cursor = memoryCursor({ 'user-1:google_calendar:sync_token': 'sync-token-1' });
    const tokenStore = makeStubStore({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GoogleCalendarConnector('user-1', tokenStore, cursor);
    await conn.connect();
    await conn.poll();

    expect(lastUrl).toContain('syncToken=sync-token-1');
    expect(cursor.snapshot['user-1:google_calendar:sync_token']).toBe('sync-token-2');
  });

  it('410 (sync token expired) clears the cursor and retries from scratch', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', (async (input: string | URL | { url: string }): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      lastUrl = url;
      callCount++;
      // First call (with syncToken): 410. Second call (no token): 200.
      if (callCount === 1) {
        return new Response('gone', { status: 410 });
      }
      return jsonResponse({ items: [], nextSyncToken: 'fresh-token' });
    }) as typeof fetch);

    const cursor = memoryCursor({ 'user-1:google_calendar:sync_token': 'expired' });
    const tokenStore = makeStubStore({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GoogleCalendarConnector('user-1', tokenStore, cursor);
    await conn.connect();
    await conn.poll();

    expect(callCount).toBe(2);
    expect(cursor.snapshot['user-1:google_calendar:sync_token']).toBe('fresh-token');
  });

  it('back-compat: third arg as a string still sets calendarId, not the cursor', async () => {
    vi.stubGlobal('fetch', (async (input: string | URL | { url: string }): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      lastUrl = url;
      return jsonResponse({ items: [] });
    }) as typeof fetch);

    const tokenStore = makeStubStore({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GoogleCalendarConnector('user-1', tokenStore, 'work@example.com');
    await conn.connect();
    await conn.poll();

    expect(lastUrl).toContain('/calendars/work%40example.com/events');
  });

  it('cursor save errors do not crash the poll', async () => {
    vi.stubGlobal('fetch', (async () => jsonResponse({ items: [], nextSyncToken: 't' })) as typeof fetch);

    const failing: CursorStore = {
      get: async () => null,
      save: async () => { throw new Error('DB down'); },
    };
    const tokenStore = makeStubStore({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conn = new GoogleCalendarConnector('user-1', tokenStore, failing);
    await conn.connect();
    await expect(conn.poll()).resolves.toEqual([]);
  });
});
