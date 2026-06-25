import type { SignalConnector, RawSignal, SignalHandler } from './connector-interface.js';
import type { OAuthTokenStore } from './oauth/token-store.js';
import type { CursorStore } from './gmail-connector.js';
import { withRetry, RetryableHttpError, parseRetryAfter } from '@skytwin/core';
import { classifyCalendarAuthoringTier } from './calendar-authoring-tier.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const DELTA_LINK_KIND = 'delta_link';
const WINDOW_END_KIND = 'window_end';
const MAX_PAGES_PER_POLL = 5;
const WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Re-bootstrap the delta (with a fresh now..now+7d window) once the stored
 * window has less than this much runway left. `calendarView/delta` fixes its
 * window at bootstrap, so without this the deltaLink tracks the ORIGINAL
 * window forever and the connector goes blind to events created beyond it.
 * Re-bootstrapping when <6 days remain keeps roughly a full week of forward
 * coverage at all times (re-bootstraps ~daily).
 */
const MIN_FORWARD_MS = 6 * DAY_MS;

const EVENT_SELECT =
  'id,subject,bodyPreview,start,end,organizer,attendees,isOrganizer,responseStatus,isCancelled,webLink,createdDateTime,lastModifiedDateTime';

/**
 * Graph returns calendar dateTimes as a naked wall-clock string with NO zone
 * suffix (e.g. `2026-06-26T10:00:00.0000000`) plus a separate `timeZone`. We
 * send `Prefer: outlook.timezone="UTC"` so the VALUES are UTC, but they still
 * lack a `Z` — so `new Date(raw)` would parse them as the WORKER's local time.
 * Append `Z` (when no zone is present) so every parse + stored string is
 * absolute UTC. Without this, conflict math and timestamps silently shift by
 * the worker's offset.
 */
function toUtcIso(dt: string | undefined): string {
  if (!dt) return '';
  return /[Zz]$|[+-]\d{2}:?\d{2}$/.test(dt) ? dt : `${dt}Z`;
}

interface GraphAttendee {
  emailAddress?: { name?: string; address?: string };
  status?: { response?: string };
}
interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: GraphAttendee[];
  isOrganizer?: boolean;
  responseStatus?: { response?: string };
  isCancelled?: boolean;
  webLink?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  '@removed'?: { reason?: string };
}
interface GraphDeltaPage {
  value?: GraphEvent[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/**
 * Outlook (Microsoft Graph) calendar connector — the Microsoft counterpart to
 * `GoogleCalendarConnector`, and the calendar half of the Outlook integration
 * alongside `OutlookMailConnector`. Polls `calendarView/delta` over a rolling
 * window and emits one `RawSignal` per event, stamped with the same
 * `AuthoringTier` (via `classifyCalendarAuthoringTier`) and shaped like the
 * Google calendar signal so downstream code treats both identically.
 *
 * Like the Outlook mail connector it uses Graph's delta cursor (a
 * `@odata.deltaLink` in the `CursorStore`), with a 410 Gone triggering a
 * re-bootstrap. Events are collected across the poll, conflict-detected as a
 * set, then emitted in a SINGLE pass — so a mid-sync 410 can't double-fire
 * handlers. Times are forced to UTC so conflict math is absolute.
 *
 * The window is refreshed proactively (see `MIN_FORWARD_MS`) so the connector
 * doesn't go blind to events created beyond the originally-bootstrapped window.
 */
export class OutlookCalendarConnector implements SignalConnector {
  readonly name = 'outlook_calendar';

  private handlers: SignalHandler[] = [];
  private connected = false;
  private deltaLink: string | null = null;
  private windowEnd: number | null = null;
  private readonly userId: string;
  private readonly tokenStore: OAuthTokenStore;
  private readonly cursorStore: CursorStore | null;

  constructor(userId: string, tokenStore: OAuthTokenStore, cursorStore: CursorStore | null = null) {
    this.userId = userId;
    this.tokenStore = tokenStore;
    this.cursorStore = cursorStore;
  }

  async connect(): Promise<void> {
    const token = await this.tokenStore.refreshIfExpired(this.userId, 'microsoft');
    if (!token) {
      throw new Error('No Microsoft OAuth token available. User must authorize first.');
    }
    if (this.cursorStore) {
      this.deltaLink = await this.cursorStore.get(this.userId, 'outlook_calendar', DELTA_LINK_KIND);
      const we = await this.cursorStore.get(this.userId, 'outlook_calendar', WINDOW_END_KIND);
      this.windowEnd = we ? Number(we) : null;
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.handlers = [];
    this.deltaLink = null;
    this.windowEnd = null;
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  private freshDeltaUrl(now: number, end: number): string {
    const params = new URLSearchParams({
      startDateTime: new Date(now).toISOString(),
      endDateTime: new Date(end).toISOString(),
      $select: EVENT_SELECT,
    });
    return `${GRAPH_API}/me/calendarView/delta?${params.toString()}`;
  }

  async poll(): Promise<RawSignal[]> {
    if (!this.connected) {
      throw new Error('OutlookCalendarConnector is not connected. Call connect() first.');
    }
    const accessToken = (await this.tokenStore.refreshIfExpired(this.userId, 'microsoft')).accessToken;

    const now = Date.now();
    // Use the stored delta cursor only while its window still has runway;
    // otherwise bootstrap a fresh now..now+7d window so far-future events
    // aren't missed.
    const windowFresh = this.deltaLink !== null && this.windowEnd !== null && this.windowEnd - now >= MIN_FORWARD_MS;
    let startUrl: string;
    let freshWindowEnd: number | null = null;
    if (windowFresh) {
      startUrl = this.deltaLink as string;
    } else {
      this.deltaLink = null;
      freshWindowEnd = now + WINDOW_DAYS * DAY_MS;
      startUrl = this.freshDeltaUrl(now, freshWindowEnd);
    }

    // Drain the delta into a flat event list (collect, don't emit yet — we
    // need the whole set for conflict detection). 410 handling mirrors the
    // mail connector: re-bootstrap only on the first request (stale stored
    // cursor); a mid-sync 410 stops and keeps what we collected.
    const events: GraphEvent[] = [];
    let url: string | undefined = startUrl;
    let pages = 0;
    let nextCursor: string | undefined;
    let rebootstrapped = false;

    while (url && pages < MAX_PAGES_PER_POLL) {
      let resp: Response;
      try {
        resp = await this.graphGet(url, accessToken);
      } catch (err) {
        if (err instanceof Error && err.message.includes('410')) {
          if (events.length === 0 && !rebootstrapped) {
            console.warn(`[outlook-calendar] delta link expired for user ${this.userId} — re-bootstrapping`);
            this.deltaLink = null;
            rebootstrapped = true;
            freshWindowEnd = now + WINDOW_DAYS * DAY_MS;
            url = this.freshDeltaUrl(now, freshWindowEnd);
            continue;
          }
          console.warn(`[outlook-calendar] delta link expired mid-sync for user ${this.userId} — returning partial`);
          break;
        }
        throw err;
      }

      const body = (await resp.json()) as GraphDeltaPage;
      for (const ev of body.value ?? []) {
        if (!ev || typeof ev.id !== 'string') continue;
        if ('@removed' in ev) continue; // deletion tombstone
        if (!ev.start?.dateTime) continue; // malformed / no start time
        events.push(ev);
      }

      pages += 1;
      if (body['@odata.deltaLink']) {
        nextCursor = body['@odata.deltaLink'];
        url = undefined;
      } else if (body['@odata.nextLink']) {
        nextCursor = body['@odata.nextLink'];
        url = body['@odata.nextLink'];
      } else {
        url = undefined;
      }
    }

    if (nextCursor) await this.persistCursor(nextCursor, freshWindowEnd);

    // Single emit pass over the collected events, with conflicts computed
    // across the whole set.
    const conflicts = this.detectConflicts(events);
    const signals: RawSignal[] = [];
    for (const ev of events) {
      const signal = this.eventToSignal(ev, conflicts.has(ev.id));
      signals.push(signal);
      for (const handler of this.handlers) handler(signal);
    }
    return signals;
  }

  private async persistCursor(link: string, windowEnd: number | null): Promise<void> {
    this.deltaLink = link;
    if (windowEnd !== null) this.windowEnd = windowEnd;
    if (this.cursorStore) {
      try {
        await this.cursorStore.save(this.userId, 'outlook_calendar', DELTA_LINK_KIND, link);
        // Persist the window end only when this poll opened a fresh window, so
        // following an existing deltaLink doesn't rewrite it.
        if (windowEnd !== null) {
          await this.cursorStore.save(this.userId, 'outlook_calendar', WINDOW_END_KIND, String(windowEnd));
        }
      } catch (err) {
        console.warn(
          `[outlook-calendar] Failed to persist delta cursor for ${this.userId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private eventToSignal(event: GraphEvent, hasConflict: boolean): RawSignal {
    const organizerEmail = event.organizer?.emailAddress?.address ?? '';
    const organizerName = event.organizer?.emailAddress?.name ?? '';
    const response = event.responseStatus?.response ?? 'none';
    // A cancelled event isn't an invite to RSVP to, even if the prior response
    // was 'notResponded' — route it as a plain calendar_event update.
    const needsResponse = !event.isCancelled && response === 'notResponded';
    const startTime = toUtcIso(event.start?.dateTime);
    const endTime = toUtcIso(event.end?.dateTime);
    const updated = toUtcIso(event.lastModifiedDateTime ?? event.createdDateTime ?? event.start?.dateTime) || 'unknown';
    const version = updated.replace(/[^a-zA-Z0-9]/g, '');

    // `isOrganizer` is Graph's direct signal that the user organized the event,
    // so we feed the organizer email as `selfEmail` to get `user_sent_originated`;
    // otherwise selfEmail='' and the classifier falls to the inbox tiers.
    const authoringTier = classifyCalendarAuthoringTier({
      organizerEmail,
      selfEmail: event.isOrganizer ? organizerEmail : '',
      attendeeCount: event.attendees?.length ?? 0,
    });

    return {
      id: `sig_outlook_cal_${event.id}_${version || 'unknown'}`,
      source: 'outlook_calendar',
      type: needsResponse ? 'meeting_invite' : 'calendar_event',
      data: {
        eventId: event.id,
        title: event.subject ?? '',
        description: event.bodyPreview ?? '',
        startTime,
        endTime,
        organizer: organizerEmail,
        organizerName,
        // Mirror the Gmail/Google-calendar `data.from` so the embedded port
        // stamps fromAddress consistently across channels.
        from: organizerEmail,
        attendees: (event.attendees ?? []).map((a) => ({
          email: a.emailAddress?.address ?? '',
          responseStatus: a.status?.response ?? 'none',
        })),
        status: event.isCancelled ? 'cancelled' : 'confirmed',
        responseStatus: response,
        hasConflict,
        requiresResponse: needsResponse,
        htmlLink: event.webLink ?? '',
        authoringTier,
      },
      timestamp: new Date(updated === 'unknown' ? Date.now() : updated),
    };
  }

  /** Overlapping-event detection — identical logic to the Google connector. */
  private detectConflicts(events: GraphEvent[]): Set<string> {
    const conflicts = new Set<string>();
    const withTimes = events
      .filter((e) => e.start?.dateTime && e.end?.dateTime)
      .map((e) => ({
        id: e.id,
        start: new Date(toUtcIso(e.start!.dateTime)).getTime(),
        end: new Date(toUtcIso(e.end!.dateTime)).getTime(),
      }))
      .sort((a, b) => a.start - b.start);

    for (let i = 0; i < withTimes.length; i++) {
      for (let j = i + 1; j < withTimes.length; j++) {
        const a = withTimes[i]!;
        const b = withTimes[j]!;
        if (b.start >= a.end) break;
        conflicts.add(a.id);
        conflicts.add(b.id);
      }
    }
    return conflicts;
  }

  private async graphGet(url: string, initialToken: string): Promise<Response> {
    let accessToken = initialToken;
    return withRetry(
      async () => {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            // Return event dateTimes in UTC (still without a Z suffix — see
            // toUtcIso) so absolute-time math is correct regardless of the
            // worker's or the user's calendar timezone.
            Prefer: 'outlook.timezone="UTC"',
          },
        });
        if (response.ok) return response;
        if (response.status === 401) {
          accessToken = (await this.tokenStore.refreshIfExpired(this.userId, 'microsoft')).accessToken;
          throw new RetryableHttpError(401, 'Graph calendarView: token expired', null);
        }
        if ([429, 500, 502, 503, 504].includes(response.status)) {
          const retryAfterMs =
            parseRetryAfter(response.headers.get('Retry-After')) ??
            parseRetryAfter(response.headers.get('RateLimit-Reset-After'));
          throw new RetryableHttpError(response.status, `Graph calendarView failed: ${response.status}`, retryAfterMs);
        }
        throw new Error(`Graph calendarView failed: ${response.status}`);
      },
      { maxRetries: 3, baseDelayMs: 1000 },
    );
  }
}
