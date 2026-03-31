import type { SignalConnector, RawSignal, SignalHandler } from './connector-interface.js';

/**
 * Mock calendar event templates.
 */
interface MockCalendarEvent {
  title: string;
  type: string;
  data: Record<string, unknown>;
}

const MOCK_CALENDAR_EVENTS: MockCalendarEvent[] = [
  {
    title: 'Team Standup',
    type: 'conflict',
    data: {
      eventId: 'evt_standup_001',
      organizer: 'team-lead@company.com',
      startTime: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
      endTime: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
      conflictsWith: 'evt_dentist_001',
      conflictsWithTitle: 'Dentist Appointment',
      attendees: ['you@company.com', 'team-lead@company.com', 'dev1@company.com', 'dev2@company.com'],
      recurrence: 'daily',
    },
  },
  {
    title: 'Client Presentation',
    type: 'new_invite',
    data: {
      eventId: 'evt_client_pres_001',
      organizer: 'sales@company.com',
      startTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      endTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 90 * 60 * 1000).toISOString(),
      attendees: ['you@company.com', 'sales@company.com', 'client@external.com'],
      location: 'Main Conference Room',
      notes: 'Please prepare Q1 metrics deck.',
      priority: 'high',
    },
  },
  {
    title: 'Lunch with Alex',
    type: 'new_invite',
    data: {
      eventId: 'evt_lunch_001',
      organizer: 'alex@friends.com',
      startTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000).toISOString(),
      endTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 13 * 60 * 60 * 1000).toISOString(),
      attendees: ['you@personal.com', 'alex@friends.com'],
      location: 'Downtown Cafe',
      category: 'personal',
    },
  },
  {
    title: '1:1 with Manager',
    type: 'reschedule_request',
    data: {
      eventId: 'evt_one_on_one_001',
      organizer: 'manager@company.com',
      originalTime: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 14 * 60 * 60 * 1000).toISOString(),
      proposedTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 14 * 60 * 60 * 1000).toISOString(),
      reason: 'Conflict with all-hands meeting',
      attendees: ['you@company.com', 'manager@company.com'],
    },
  },
  {
    title: 'Focus Time Block',
    type: 'conflict',
    data: {
      eventId: 'evt_focus_001',
      organizer: 'you@company.com',
      startTime: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000).toISOString(),
      endTime: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 11 * 60 * 60 * 1000).toISOString(),
      conflictsWith: 'evt_ad_hoc_meeting',
      conflictsWithTitle: 'Ad-hoc Architecture Review',
      isProtectedTime: true,
      category: 'focus',
    },
  },
  {
    title: 'Sprint Retrospective',
    type: 'cancelled',
    data: {
      eventId: 'evt_retro_001',
      organizer: 'scrum-master@company.com',
      originalTime: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
      reason: 'Sprint extended by one week',
      newDate: new Date(Date.now() + 11 * 24 * 60 * 60 * 1000).toISOString(),
    },
  },
];

/**
 * MockCalendarConnector simulates a calendar integration for development
 * and testing. It generates realistic calendar signals including conflicts,
 * new invites, reschedule requests, and cancellations.
 */
export class MockCalendarConnector implements SignalConnector {
  readonly name = 'mock-calendar';

  private connected = false;
  private handlers: SignalHandler[] = [];
  private pollIndex = 0;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  async connect(): Promise<void> {
    this.connected = true;
    this.pollIndex = 0;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.handlers = [];
  }

  async poll(): Promise<RawSignal[]> {
    if (!this.connected) {
      throw new Error('MockCalendarConnector is not connected. Call connect() first.');
    }

    // Return 1-2 calendar events per poll
    const batchSize = 1 + Math.floor(Math.random() * 2);
    const signals: RawSignal[] = [];

    for (let i = 0; i < batchSize; i++) {
      const eventTemplate = MOCK_CALENDAR_EVENTS[this.pollIndex % MOCK_CALENDAR_EVENTS.length]!;
      const signal = this.calendarEventToSignal(eventTemplate);
      signals.push(signal);
      this.pollIndex++;
    }

    // Notify registered handlers
    for (const signal of signals) {
      for (const handler of this.handlers) {
        handler(signal);
      }
    }

    return signals;
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Start automatic polling at the given interval (for simulation).
   */
  startAutoPolling(intervalMs: number): void {
    if (!this.connected) {
      throw new Error('Must be connected before starting auto-polling.');
    }

    this.pollingTimer = setInterval(() => {
      void this.poll();
    }, intervalMs);
  }

  // ── Private helpers ──────────────────────────────────────────────

  private calendarEventToSignal(event: MockCalendarEvent): RawSignal {
    return {
      id: `sig_cal_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      source: 'calendar',
      type: `calendar_${event.type}`,
      data: {
        title: event.title,
        eventType: event.type,
        ...event.data,
      },
      timestamp: new Date(),
    };
  }
}
