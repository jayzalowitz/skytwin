import type { SignalConnector, RawSignal, SignalHandler } from './connector-interface.js';
import type { OAuthTokenStore } from './oauth/token-store.js';
import type { CursorStore } from './gmail-connector.js';
import { withRetry, RetryableHttpError, parseRetryAfter } from '@skytwin/core';
import { classifyCalendarAuthoringTier } from './calendar-authoring-tier.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const DELTA_LINK_KIND = 'delta_link';
const MAX_PAGES_PER_POLL = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * `calendarView/delta` fixes its time window at bootstrap, so the deltaLink only
 * ever tracks changes to events inside the window set when it was created. A
 * generous 30-day window means the connector sees roughly a month of forward
 * calendar at any given bootstrap; events scheduled beyond the window (or created
 * after the worker has run long enough that the window has aged out) are picked
 * up on the next re-bootstrap (a 410 or a fresh connect on worker restart /
 * user re-discovery).
 *
 * Why NOT a proactive rolling re-bootstrap: re-fetching a fresh window re-emits
 * EVERY event in it, and `SignalDeduper`'s TTL (24h) means a periodic
 * re-bootstrap (e.g. daily) would re-present unchanged events past their dedup
 * window, creating duplicate decisions/approvals. Following the deltaLink
 * incrementally only emits real changes; the rare 410/restart re-emit is
 * absorbed by the deduper's persistent ledger. A true rolling window without
 * re-emit needs `events/delta` (no fixed window, but no recurrence expansion) —
 * tracked as a follow-up.
 */
const WINDOW_DAYS = 30;

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
 * re-bootstrap. Following the deltaLink yields only CHANGED events, so steady
 * state emits no duplicates; the window is bootstrapped once (30 days, see
 * `WINDOW_DAYS`) and refreshed only on a 410 or a fresh connect. Events are
 * collected across the poll, conflict-detected as a set, then emitted in a
 * SINGLE pass — so a mid-sync 410 can't double-fire handlers. Times are forced
 * to UTC so conflict math is absolute.
 */
export class OutlookCalendarConnector implements SignalConnector {
  readonly name = 'outlook_calendar';

  private handlers: SignalHandler[] = [];
  private connected = false;
  private deltaLink: string | null = null;
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
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.handlers = [];
    this.deltaLink = null;
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  private freshDeltaUrl(): string {
    const now = Date.now();
    const params = new URLSearchParams({
      startDateTime: new Date(now).toISOString(),
      endDateTime: new Date(now + WINDOW_DAYS * DAY_MS).toISOString(),
      $select: EVENT_SELECT,
    });
    return `${GRAPH_API}/me/calendarView/delta?${params.toString()}`;
  }

  async poll(): Promise<RawSignal[]> {
    if (!this.connected) {
      throw new Error('OutlookCalendarConnector is not connected. Call connect() first.');
    }
    const accessToken = (await this.tokenStore.refreshIfExpired(this.userId, 'microsoft')).accessToken;

    // Follow the stored deltaLink (incremental — changed events only) when we
    // have one; otherwise bootstrap a fresh now..now+30d window.
    // Drain the delta into a flat event list (collect, don't emit yet — we
    // need the whole set for conflict detection). 410 handling mirrors the
    // mail connector: re-bootstrap only on the first request (stale stored
    // cursor); a mid-sync 410 stops and keeps what we collected.
    const events: GraphEvent[] = [];
    let url: string | undefined = this.deltaLink ?? this.freshDeltaUrl();
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
            url = this.freshDeltaUrl();
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

    if (nextCursor) await this.persistCursor(nextCursor);

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

  private async persistCursor(link: string): Promise<void> {
    this.deltaLink = link;
    if (this.cursorStore) {
      try {
        await this.cursorStore.save(this.userId, 'outlook_calendar', DELTA_LINK_KIND, link);
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
    // `??` only falls through on null/undefined, but Graph can hand back an
    // empty string — pick the first NON-EMPTY timestamp so an empty
    // `lastModifiedDateTime` doesn't collapse the version to 'unknown' (which
    // would freeze the signal id and defeat the `_<version>` change-dedup) or
    // trigger the Date.now() timestamp fallback. The poll() start-guard
    // guarantees a non-empty `start.dateTime`, so this never reaches 'unknown'.
    const updatedSource = [event.lastModifiedDateTime, event.createdDateTime, event.start?.dateTime].find(
      (d): d is string => typeof d === 'string' && d.length > 0,
    );
    const updated = toUtcIso(updatedSource) || 'unknown';
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

  /**
   * Overlapping-event detection — same sweep as the Google connector, but
   * cancelled events are excluded: Outlook keeps the original start/end on an
   * `isCancelled` event (Google strips them in its sync), so without this a
   * cancelled meeting would spuriously flag a real one as conflicting.
   */
  private detectConflicts(events: GraphEvent[]): Set<string> {
    const conflicts = new Set<string>();
    const withTimes = events
      .filter((e) => !e.isCancelled && e.start?.dateTime && e.end?.dateTime)
      .map((e) => ({
        id: e.id,
        start: new Date(toUtcIso(e.start!.dateTime)).getTime(),
        end: new Date(toUtcIso(e.end!.dateTime)).getTime(),
      }))
      // Drop unparseable times — a NaN start/end makes every `b.start >= a.end`
      // comparison false, which would break the early-exit and over-flag.
      .filter((e) => !Number.isNaN(e.start) && !Number.isNaN(e.end))
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
