import type { StoredSignal, SignalCorrelation } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

/**
 * CrossDomainCorrelator finds correlations between signals from different
 * domains (email, calendar, finance, subscriptions, etc.).
 *
 * Implements 4 correlation rules:
 *   1. Calendar-Email link
 *   2. Same-sender threading
 *   3. Calendar conflict
 *   4. Subscription-financial link
 */
export class CrossDomainCorrelator {
  /**
   * Find correlations between the current signal and recent signals.
   * Implements 4 correlation rules (time-boxed scope).
   */
  findCorrelations(
    currentSignal: StoredSignal,
    recentSignals: StoredSignal[],
  ): SignalCorrelation[] {
    const correlations: SignalCorrelation[] = [];

    // Rule 1: Calendar-Email link
    // If current signal is email and any recent signal is calendar (or vice versa),
    // check if email subject/data mentions calendar event title/data
    for (const recent of recentSignals) {
      if (this.isCalendarEmailLink(currentSignal, recent)) {
        correlations.push({
          id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          signalIds: [currentSignal.id, recent.id],
          correlationType: 'calendar_email_link',
          confidence: ConfidenceLevel.MODERATE,
          description: 'Email references calendar event',
        });
      }
    }

    // Rule 2: Same-sender threading
    // Multiple signals from same source within 24h
    const sameSender = recentSignals.filter(s =>
      s.source === currentSignal.source &&
      s.domain === currentSignal.domain &&
      s.id !== currentSignal.id &&
      Math.abs(s.timestamp.getTime() - currentSignal.timestamp.getTime()) < 24 * 60 * 60 * 1000,
    );
    if (sameSender.length > 0) {
      correlations.push({
        id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        signalIds: [currentSignal.id, ...sameSender.map(s => s.id)],
        correlationType: 'same_sender_thread',
        confidence: ConfidenceLevel.HIGH,
        description: `${sameSender.length + 1} signals from ${currentSignal.source} within 24h`,
      });
    }

    // Rule 3: Calendar conflict
    // Two calendar events with overlapping times
    if (currentSignal.domain === 'calendar') {
      for (const recent of recentSignals) {
        if (recent.domain === 'calendar' && this.isCalendarConflict(currentSignal, recent)) {
          correlations.push({
            id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            signalIds: [currentSignal.id, recent.id],
            correlationType: 'calendar_conflict',
            confidence: ConfidenceLevel.CONFIRMED,
            description: 'Calendar events overlap in time',
          });
        }
      }
    }

    // Rule 4: Subscription-financial link
    // Subscription email + recurring charge mention
    if (this.isSubscriptionRelated(currentSignal)) {
      const financialSignals = recentSignals.filter(s =>
        s.domain === 'finance' || s.domain === 'subscriptions',
      );
      for (const financial of financialSignals) {
        correlations.push({
          id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          signalIds: [currentSignal.id, financial.id],
          correlationType: 'subscription_financial',
          confidence: ConfidenceLevel.MODERATE,
          description: 'Subscription renewal linked to financial activity',
        });
      }
    }

    return correlations;
  }

  private isCalendarEmailLink(a: StoredSignal, b: StoredSignal): boolean {
    const [email, calendar] = a.domain === 'email' ? [a, b] : [b, a];
    if (email?.domain !== 'email' || calendar?.domain !== 'calendar') return false;

    const emailText = JSON.stringify(email.data).toLowerCase();
    const calendarTitle = String(calendar.data['title'] ?? calendar.data['subject'] ?? '').toLowerCase();

    if (!calendarTitle || calendarTitle.length < 3) return false;
    return emailText.includes(calendarTitle);
  }

  private isCalendarConflict(a: StoredSignal, b: StoredSignal): boolean {
    const aStart = a.data['startTime'] as string | undefined;
    const aEnd = a.data['endTime'] as string | undefined;
    const bStart = b.data['startTime'] as string | undefined;
    const bEnd = b.data['endTime'] as string | undefined;

    if (!aStart || !aEnd || !bStart || !bEnd) return false;

    const aStartTime = new Date(aStart).getTime();
    const aEndTime = new Date(aEnd).getTime();
    const bStartTime = new Date(bStart).getTime();
    const bEndTime = new Date(bEnd).getTime();

    return aStartTime < bEndTime && bStartTime < aEndTime;
  }

  private isSubscriptionRelated(signal: StoredSignal): boolean {
    const text = JSON.stringify(signal.data).toLowerCase();
    return ['subscription', 'renewal', 'recurring', 'billing', 'auto-renew'].some(kw => text.includes(kw));
  }
}
