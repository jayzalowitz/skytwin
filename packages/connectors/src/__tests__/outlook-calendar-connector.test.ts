import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { OutlookCalendarConnector } from '../outlook-calendar-connector.js';
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

const DELTA_KEY = 'user-1|outlook_calendar|delta_link';

function makeCursorStore(seeds: Record<string, string> = {}): CursorStore & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seeds));
  return {
    map,
    get: async (u, p, k) => map.get(`${u}|${p}|${k}`) ?? null,
    save: async (u, p, k, v) => void map.set(`${u}|${p}|${k}`, v),
  };
}

interface EvtOver {
  id?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{ emailAddress?: { address?: string }; status?: { response?: string } }>;
  isOrganizer?: boolean;
  responseStatus?: { response?: string };
  isCancelled?: boolean;
}
function gevent(o: EvtOver = {}): unknown {
  return {
    id: o.id ?? 'e1',
    subject: 'Standup',
    bodyPreview: 'desc',
    // Naked (no-Z) wall-clock string, as Graph actually returns.
    start: o.start ?? { dateTime: '2026-06-26T10:00:00.0000000', timeZone: 'UTC' },
    end: o.end ?? { dateTime: '2026-06-26T10:30:00.0000000', timeZone: 'UTC' },
    organizer: o.organizer ?? { emailAddress: { name: 'Boss', address: 'boss@example.com' } },
    attendees: o.attendees ?? [{ emailAddress: { address: 'me@example.com' }, status: { response: 'notResponded' } }],
    isOrganizer: o.isOrganizer ?? false,
    responseStatus: o.responseStatus ?? { response: 'notResponded' },
    isCancelled: o.isCancelled ?? false,
    webLink: 'https://outlook.example/e',
    createdDateTime: '2026-06-20T00:00:00Z',
    lastModifiedDateTime: '2026-06-21T00:00:00Z',
  };
}
function res(status: number, body: unknown, headers: Record<string, string> = {}): unknown {
  return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (k: string) => headers[k] ?? null } };
}

const fetchMock = vi.fn();
async function connected(cursor?: CursorStore): Promise<OutlookCalendarConnector> {
  const conn = new OutlookCalendarConnector('user-1', makeStubStore(VALID_TOKEN), cursor ?? null);
  await conn.connect();
  return conn;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('OutlookCalendarConnector', () => {
  it('connect() throws when no Microsoft token is available', async () => {
    await expect(new OutlookCalendarConnector('u', makeStubStore(null)).connect()).rejects.toThrow();
  });

  it('bootstraps from calendarView/delta and shapes a meeting_invite signal', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { value: [gevent({ id: 'e1' })], '@odata.deltaLink': 'DELTA1' }));
    const cursor = makeCursorStore();
    const conn = await connected(cursor);
    const signals = await conn.poll();

    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/me/calendarView/delta');
    // Sends Prefer: UTC so dateTimes come back absolute.
    const opts = (fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }])[1];
    expect(opts.headers.Prefer).toContain('outlook.timezone="UTC"');

    expect(signals).toHaveLength(1);
    expect(signals[0]!.source).toBe('outlook_calendar');
    expect(signals[0]!.type).toBe('meeting_invite');
    expect(signals[0]!.data.requiresResponse).toBe(true);
    expect(cursor.map.get(DELTA_KEY)).toBe('DELTA1');
  });

  it('bootstraps over a 30-day forward window', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { value: [], '@odata.deltaLink': 'D' }));
    await (await connected()).poll();
    const url = (fetchMock.mock.calls[0] as [string])[0];
    const params = new URL(url).searchParams;
    const start = new Date(params.get('startDateTime')!).getTime();
    const end = new Date(params.get('endDateTime')!).getTime();
    const days = Math.round((end - start) / (24 * 60 * 60 * 1000));
    expect(days).toBe(30);
  });

  it('normalizes naked Graph dateTimes to UTC (appends Z) so absolute time is correct', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { value: [gevent({ id: 'e1' })], '@odata.deltaLink': 'D' }));
    const conn = await connected();
    const [sig] = await conn.poll();
    expect(sig!.data.startTime).toBe('2026-06-26T10:00:00.0000000Z');
    expect(Number.isNaN(new Date(sig!.data.startTime as string).getTime())).toBe(false);
  });

  it('classifies a user-organized event as user_sent_originated (calendar_event)', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, {
        value: [gevent({ id: 'mine', isOrganizer: true, organizer: { emailAddress: { address: 'me@example.com' } }, responseStatus: { response: 'organizer' } })],
        '@odata.deltaLink': 'D',
      }),
    );
    const [sig] = await (await connected()).poll();
    expect(sig!.data.authoringTier).toBe('user_sent_originated');
    expect(sig!.type).toBe('calendar_event');
  });

  it('routes a cancelled event as calendar_event, not an invite to RSVP to', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, { value: [gevent({ id: 'x', isCancelled: true, responseStatus: { response: 'notResponded' } })], '@odata.deltaLink': 'D' }),
    );
    const [sig] = await (await connected()).poll();
    expect(sig!.data.status).toBe('cancelled');
    expect(sig!.type).toBe('calendar_event');
    expect(sig!.data.requiresResponse).toBe(false);
  });

  it('flags overlapping events as conflicts', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, {
        value: [
          gevent({ id: 'a', start: { dateTime: '2026-06-26T10:00:00Z' }, end: { dateTime: '2026-06-26T11:00:00Z' } }),
          gevent({ id: 'b', start: { dateTime: '2026-06-26T10:30:00Z' }, end: { dateTime: '2026-06-26T11:30:00Z' } }),
          gevent({ id: 'c', start: { dateTime: '2026-06-26T12:00:00Z' }, end: { dateTime: '2026-06-26T12:30:00Z' } }),
        ],
        '@odata.deltaLink': 'D',
      }),
    );
    const signals = await (await connected()).poll();
    const byId = Object.fromEntries(signals.map((s) => [s.data.eventId, s.data.hasConflict]));
    expect(byId['a']).toBe(true);
    expect(byId['b']).toBe(true);
    expect(byId['c']).toBe(false);
  });

  it('a cancelled event does not create a spurious conflict on a real overlapping event', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, {
        value: [
          gevent({ id: 'real', start: { dateTime: '2026-06-26T10:00:00Z' }, end: { dateTime: '2026-06-26T11:00:00Z' } }),
          gevent({ id: 'dead', isCancelled: true, start: { dateTime: '2026-06-26T10:30:00Z' }, end: { dateTime: '2026-06-26T11:30:00Z' } }),
        ],
        '@odata.deltaLink': 'D',
      }),
    );
    const signals = await (await connected()).poll();
    const byId = Object.fromEntries(signals.map((s) => [s.data.eventId, s.data.hasConflict]));
    expect(byId['real']).toBe(false); // the cancelled overlap must not flag it
    expect(byId['dead']).toBe(false);
  });

  it('skips tombstones (@removed) and events with no start time', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, { value: [gevent({ id: 'real' }), { id: 'del', '@removed': { reason: 'deleted' } }, { id: 'nostart', subject: 'x' }], '@odata.deltaLink': 'D' }),
    );
    const signals = await (await connected()).poll();
    expect(signals.map((s) => s.data.eventId)).toEqual(['real']);
  });

  it('drains paginated delta (nextLink → deltaLink) and persists the deltaLink', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { value: [gevent({ id: 'a' })], '@odata.nextLink': 'NEXT1' }))
      .mockResolvedValueOnce(res(200, { value: [gevent({ id: 'b' })], '@odata.deltaLink': 'D2' }));
    const cursor = makeCursorStore();
    const signals = await (await connected(cursor)).poll();
    expect(signals.map((s) => s.data.eventId)).toEqual(['a', 'b']);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe('NEXT1');
    expect(cursor.map.get(DELTA_KEY)).toBe('D2');
  });

  it('follows a stored deltaLink incrementally (no fresh bootstrap)', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { value: [gevent({ id: 'i' })], '@odata.deltaLink': 'D2' }));
    const cursor = makeCursorStore({ [DELTA_KEY]: 'STORED' });
    await (await connected(cursor)).poll();
    // Following the cursor emits only changed events — no full-window re-fetch.
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('STORED');
    expect(cursor.map.get(DELTA_KEY)).toBe('D2');
  });

  it('a second poll follows the deltaLink and does not re-fetch the window (no re-emit storm)', async () => {
    fetchMock
      // poll 1: bootstrap returns two events + a deltaLink
      .mockResolvedValueOnce(res(200, { value: [gevent({ id: 'a' }), gevent({ id: 'b' })], '@odata.deltaLink': 'DL1' }))
      // poll 2: following DL1 returns only the one changed event + a new deltaLink
      .mockResolvedValueOnce(res(200, { value: [gevent({ id: 'b' })], '@odata.deltaLink': 'DL2' }));
    const cursor = makeCursorStore();
    const conn = await connected(cursor);

    const first = await conn.poll();
    expect(first.map((s) => s.data.eventId)).toEqual(['a', 'b']);
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/me/calendarView/delta');

    const second = await conn.poll();
    // Second poll FOLLOWS the stored deltaLink (incremental) — it must NOT
    // re-issue a full calendarView/delta bootstrap that would re-emit 'a'.
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe('DL1');
    expect(second.map((s) => s.data.eventId)).toEqual(['b']);
    expect(cursor.map.get(DELTA_KEY)).toBe('DL2');
  });

  it('re-bootstraps on a 410 (stale stored cursor)', async () => {
    fetchMock
      .mockResolvedValueOnce(res(410, {}))
      .mockResolvedValueOnce(res(200, { value: [gevent({ id: 'r' })], '@odata.deltaLink': 'D4' }));
    const cursor = makeCursorStore({ [DELTA_KEY]: 'STALE' });
    const signals = await (await connected(cursor)).poll();
    expect((fetchMock.mock.calls[1] as [string])[0]).toContain('/me/calendarView/delta');
    expect(signals.map((s) => s.data.eventId)).toEqual(['r']);
    expect(cursor.map.get(DELTA_KEY)).toBe('D4');
  });

  it('poll() throws before connect()', async () => {
    await expect(new OutlookCalendarConnector('u', makeStubStore(VALID_TOKEN)).poll()).rejects.toThrow(/not connected/);
  });
});
