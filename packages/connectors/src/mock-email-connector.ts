import type { SignalConnector, RawSignal, SignalHandler } from './connector-interface.js';

/**
 * Mock email templates for realistic simulation.
 */
interface MockEmail {
  from: string;
  subject: string;
  type: string;
  requiresResponse: boolean;
  data: Record<string, unknown>;
}

const MOCK_EMAILS: MockEmail[] = [
  {
    from: 'billing@streamingservice.com',
    subject: 'Your subscription renewal is coming up',
    type: 'subscription_renewal',
    requiresResponse: false,
    data: {
      service: 'StreamingService Pro',
      amount: '$14.99',
      costCents: 1499,
      renewalDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      subscriptionId: 'sub_streaming_001',
    },
  },
  {
    from: 'calendar@company.com',
    subject: 'New meeting invite: Q2 Planning Review',
    type: 'meeting_invite',
    requiresResponse: true,
    data: {
      eventId: 'evt_q2planning_001',
      organizer: 'manager@company.com',
      startTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      duration: 60,
      attendees: ['you@company.com', 'team-lead@company.com', 'director@company.com'],
      location: 'Conference Room B',
    },
  },
  {
    from: 'noreply@newsletter.dev',
    subject: 'Weekly Tech Digest - March 2026',
    type: 'newsletter',
    requiresResponse: false,
    data: {
      category: 'newsletter',
      unsubscribeLink: 'https://newsletter.dev/unsub/12345',
    },
  },
  {
    from: 'support@saasplatform.io',
    subject: 'Action required: Your trial is expiring',
    type: 'trial_expiration',
    requiresResponse: true,
    data: {
      service: 'SaaS Platform',
      trialEndDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      plans: [
        { name: 'Basic', priceCents: 999 },
        { name: 'Pro', priceCents: 2999 },
      ],
    },
  },
  {
    from: 'receipts@grocerystore.com',
    subject: 'Your weekly grocery order is ready to reorder',
    type: 'grocery_reorder',
    requiresResponse: false,
    data: {
      items: [
        { name: 'Organic Milk', quantity: 2, priceCents: 549 },
        { name: 'Whole Wheat Bread', quantity: 1, priceCents: 399 },
        { name: 'Bananas (bunch)', quantity: 1, priceCents: 129 },
        { name: 'Free Range Eggs', quantity: 1, priceCents: 499 },
      ],
      lastOrderDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  },
  {
    from: 'colleague@company.com',
    subject: 'Quick question about the project timeline',
    type: 'work_email',
    requiresResponse: true,
    data: {
      threadId: 'thread_project_timeline_042',
      priority: 'medium',
    },
  },
  {
    from: 'booking@travelsite.com',
    subject: 'Price drop alert: Flight to San Francisco',
    type: 'travel_alert',
    requiresResponse: false,
    data: {
      destination: 'San Francisco, CA',
      originalPrice: 45000,
      newPrice: 32000,
      travelType: 'flight',
      departureDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      returnDate: new Date(Date.now() + 34 * 24 * 60 * 60 * 1000).toISOString(),
      airline: 'Pacific Airways',
    },
  },
];

/**
 * MockEmailConnector simulates an email inbox for development and testing.
 * It generates realistic email signals including subscription renewals,
 * meeting invites, newsletters, and work correspondence.
 */
export class MockEmailConnector implements SignalConnector {
  readonly name = 'mock-email';

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
      throw new Error('MockEmailConnector is not connected. Call connect() first.');
    }

    // Return 1-3 emails per poll, cycling through mock data
    const batchSize = 1 + Math.floor(Math.random() * 3);
    const signals: RawSignal[] = [];

    for (let i = 0; i < batchSize; i++) {
      const emailTemplate = MOCK_EMAILS[this.pollIndex % MOCK_EMAILS.length]!;
      const signal = this.emailToSignal(emailTemplate);
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

  private emailToSignal(email: MockEmail): RawSignal {
    return {
      id: `sig_email_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      source: 'email',
      type: email.type,
      data: {
        from: email.from,
        subject: email.subject,
        requiresResponse: email.requiresResponse,
        ...email.data,
      },
      timestamp: new Date(),
    };
  }
}
