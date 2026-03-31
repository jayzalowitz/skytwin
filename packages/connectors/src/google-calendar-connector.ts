import type { SignalConnector, RawSignal, SignalHandler } from './connector-interface.js';
import type { OAuthTokenStore } from './oauth/token-store.js';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  organizer: { email: string; displayName?: string };
  attendees?: Array<{
    email: string;
    responseStatus: string;
    self?: boolean;
  }>;
  status: string;
  htmlLink: string;
  created: string;
  updated: string;
}

/**
 * Google Calendar connector that polls for new and updated events.
 * Uses syncToken for incremental sync after the initial fetch.
 */
export class GoogleCalendarConnector implements SignalConnector {
  readonly name = 'google-calendar';

  private handlers: SignalHandler[] = [];
  private connected = false;
  private syncToken: string | null = null;
  private readonly userId: string;
  private readonly tokenStore: OAuthTokenStore;
  private readonly calendarId: string;

  constructor(userId: string, tokenStore: OAuthTokenStore, calendarId = 'primary') {
    this.userId = userId;
    this.tokenStore = tokenStore;
    this.calendarId = calendarId;
  }

  async connect(): Promise<void> {
    const token = await this.tokenStore.refreshIfExpired(this.userId, 'google');
    if (!token) {
      throw new Error('No Google OAuth token available. User must authorize first.');
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.handlers = [];
    this.syncToken = null;
  }

  async poll(): Promise<RawSignal[]> {
    if (!this.connected) {
      throw new Error('GoogleCalendarConnector is not connected. Call connect() first.');
    }

    const token = await this.tokenStore.refreshIfExpired(this.userId, 'google');
    const headers = { Authorization: `Bearer ${token.accessToken}` };

    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '20',
    });

    if (this.syncToken) {
      params.set('syncToken', this.syncToken);
    } else {
      // Initial sync: get events from now to 7 days ahead
      const now = new Date();
      const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      params.set('timeMin', now.toISOString());
      params.set('timeMax', weekAhead.toISOString());
    }

    const url = `${CALENDAR_API}/calendars/${encodeURIComponent(this.calendarId)}/events?${params}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 410) {
        // Sync token expired, do a full resync
        this.syncToken = null;
        return this.poll();
      }
      throw new Error(`Calendar API failed: ${response.status}`);
    }

    const data = await response.json() as {
      items: CalendarEvent[];
      nextSyncToken?: string;
      nextPageToken?: string;
    };

    // Store sync token for next incremental poll
    if (data.nextSyncToken) {
      this.syncToken = data.nextSyncToken;
    }

    const events = data.items ?? [];
    const signals: RawSignal[] = [];

    // Detect conflicts (overlapping events)
    const conflicts = this.detectConflicts(events);

    for (const event of events) {
      const signal = this.eventToSignal(event, conflicts.has(event.id));
      signals.push(signal);

      for (const handler of this.handlers) {
        handler(signal);
      }
    }

    return signals;
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  private eventToSignal(event: CalendarEvent, hasConflict: boolean): RawSignal {
    const selfAttendee = event.attendees?.find((a) => a.self);
    const needsResponse = selfAttendee?.responseStatus === 'needsAction';

    return {
      id: `sig_cal_${event.id}_${Date.now()}`,
      source: 'google_calendar',
      type: needsResponse ? 'meeting_invite' : 'calendar_event',
      data: {
        eventId: event.id,
        title: event.summary,
        description: event.description ?? '',
        startTime: event.start.dateTime ?? event.start.date ?? '',
        endTime: event.end.dateTime ?? event.end.date ?? '',
        organizer: event.organizer.email,
        organizerName: event.organizer.displayName ?? '',
        attendees: (event.attendees ?? []).map((a) => ({
          email: a.email,
          responseStatus: a.responseStatus,
        })),
        status: event.status,
        responseStatus: selfAttendee?.responseStatus ?? 'unknown',
        hasConflict,
        requiresResponse: needsResponse,
        htmlLink: event.htmlLink,
      },
      timestamp: new Date(event.updated ?? event.created),
    };
  }

  private detectConflicts(events: CalendarEvent[]): Set<string> {
    const conflicts = new Set<string>();
    const withTimes = events
      .filter((e) => e.start.dateTime && e.end.dateTime)
      .map((e) => ({
        id: e.id,
        start: new Date(e.start.dateTime!).getTime(),
        end: new Date(e.end.dateTime!).getTime(),
      }))
      .sort((a, b) => a.start - b.start);

    for (let i = 0; i < withTimes.length; i++) {
      for (let j = i + 1; j < withTimes.length; j++) {
        const a = withTimes[i]!;
        const b = withTimes[j]!;
        // b starts after a ends → no overlap with b or anything after
        if (b.start >= a.end) break;
        // overlap detected
        conflicts.add(a.id);
        conflicts.add(b.id);
      }
    }

    return conflicts;
  }
}
