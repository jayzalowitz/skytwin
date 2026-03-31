import type { DecisionObject } from '@skytwin/shared-types';
import { SituationType } from '@skytwin/shared-types';

/**
 * The SituationInterpreter examines raw events from signal connectors and
 * creates typed DecisionObjects. It classifies the situation type, determines
 * urgency, and extracts a structured representation of the decision at hand.
 */
export class SituationInterpreter {
  /**
   * Interpret a raw event into a structured DecisionObject.
   */
  interpret(rawEvent: Record<string, unknown>): DecisionObject {
    const situationType = this.classifySituation(rawEvent);
    const domain = this.extractDomain(rawEvent, situationType);
    const urgency = this.assessUrgency(rawEvent, situationType);
    const summary = this.generateSummary(rawEvent, situationType);

    return {
      id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      situationType,
      domain,
      urgency,
      summary,
      rawData: rawEvent,
      interpretedAt: new Date(),
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Classify the situation type based on signals in the raw event.
   */
  private classifySituation(rawEvent: Record<string, unknown>): SituationType {
    const source = String(rawEvent['source'] ?? '').toLowerCase();
    const type = String(rawEvent['type'] ?? '').toLowerCase();
    const subject = String(rawEvent['subject'] ?? '').toLowerCase();
    const category = String(rawEvent['category'] ?? '').toLowerCase();

    // Email triage
    if (
      source.includes('email') ||
      type.includes('email') ||
      type.includes('message')
    ) {
      // Check for subscription renewal emails
      if (
        subject.includes('renewal') ||
        subject.includes('subscription') ||
        subject.includes('billing') ||
        subject.includes('payment')
      ) {
        return SituationType.SUBSCRIPTION_RENEWAL;
      }
      // Check for calendar-related emails
      if (
        subject.includes('meeting') ||
        subject.includes('invite') ||
        subject.includes('calendar')
      ) {
        return SituationType.CALENDAR_CONFLICT;
      }
      return SituationType.EMAIL_TRIAGE;
    }

    // Calendar events
    if (
      source.includes('calendar') ||
      type.includes('calendar') ||
      type.includes('event') ||
      type.includes('meeting')
    ) {
      return SituationType.CALENDAR_CONFLICT;
    }

    // Subscription/billing
    if (
      type.includes('subscription') ||
      type.includes('renewal') ||
      type.includes('billing') ||
      category.includes('subscription')
    ) {
      return SituationType.SUBSCRIPTION_RENEWAL;
    }

    // Grocery/shopping
    if (
      type.includes('grocery') ||
      type.includes('reorder') ||
      type.includes('shopping') ||
      category.includes('grocery')
    ) {
      return SituationType.GROCERY_REORDER;
    }

    // Travel
    if (
      type.includes('travel') ||
      type.includes('flight') ||
      type.includes('hotel') ||
      type.includes('booking') ||
      category.includes('travel')
    ) {
      return SituationType.TRAVEL_DECISION;
    }

    return SituationType.GENERIC;
  }

  /**
   * Extract the relevant domain from the raw event.
   */
  private extractDomain(
    rawEvent: Record<string, unknown>,
    situationType: SituationType,
  ): string {
    // Use explicit domain if provided
    if (typeof rawEvent['domain'] === 'string') {
      return rawEvent['domain'];
    }

    // Derive from situation type
    const domainMap: Record<SituationType, string> = {
      [SituationType.EMAIL_TRIAGE]: 'email',
      [SituationType.CALENDAR_CONFLICT]: 'calendar',
      [SituationType.SUBSCRIPTION_RENEWAL]: 'subscriptions',
      [SituationType.GROCERY_REORDER]: 'shopping',
      [SituationType.TRAVEL_DECISION]: 'travel',
      [SituationType.GENERIC]: String(rawEvent['source'] ?? 'unknown'),
    };

    return domainMap[situationType];
  }

  /**
   * Assess urgency based on timing signals in the raw event.
   */
  private assessUrgency(
    rawEvent: Record<string, unknown>,
    situationType: SituationType,
  ): 'low' | 'medium' | 'high' | 'critical' {
    // Check for explicit urgency
    const explicitUrgency = rawEvent['urgency'] ?? rawEvent['priority'];
    if (typeof explicitUrgency === 'string') {
      const normalized = explicitUrgency.toLowerCase();
      if (['low', 'medium', 'high', 'critical'].includes(normalized)) {
        return normalized as 'low' | 'medium' | 'high' | 'critical';
      }
    }

    // Check deadline proximity
    const deadline = rawEvent['deadline'] ?? rawEvent['dueDate'] ?? rawEvent['expiresAt'];
    if (deadline) {
      const deadlineDate = new Date(String(deadline));
      const hoursUntilDeadline =
        (deadlineDate.getTime() - Date.now()) / (1000 * 60 * 60);

      if (hoursUntilDeadline < 1) return 'critical';
      if (hoursUntilDeadline < 4) return 'high';
      if (hoursUntilDeadline < 24) return 'medium';
      return 'low';
    }

    // Default urgency by situation type
    const defaultUrgency: Record<SituationType, 'low' | 'medium' | 'high' | 'critical'> = {
      [SituationType.EMAIL_TRIAGE]: 'low',
      [SituationType.CALENDAR_CONFLICT]: 'high',
      [SituationType.SUBSCRIPTION_RENEWAL]: 'medium',
      [SituationType.GROCERY_REORDER]: 'low',
      [SituationType.TRAVEL_DECISION]: 'medium',
      [SituationType.GENERIC]: 'low',
    };

    return defaultUrgency[situationType];
  }

  /**
   * Generate a human-readable summary of the situation.
   */
  private generateSummary(
    rawEvent: Record<string, unknown>,
    situationType: SituationType,
  ): string {
    const subject = rawEvent['subject'] ?? rawEvent['title'] ?? rawEvent['name'];
    const from = rawEvent['from'] ?? rawEvent['sender'] ?? rawEvent['source'];

    switch (situationType) {
      case SituationType.EMAIL_TRIAGE: {
        const emailSubject = subject ? `"${String(subject)}"` : 'an email';
        const sender = from ? ` from ${String(from)}` : '';
        return `Email triage needed for ${emailSubject}${sender}.`;
      }

      case SituationType.CALENDAR_CONFLICT: {
        const eventName = subject ? `"${String(subject)}"` : 'a calendar event';
        const time = rawEvent['startTime'] ?? rawEvent['time'];
        const timeStr = time ? ` at ${String(time)}` : '';
        return `Calendar conflict detected for ${eventName}${timeStr}.`;
      }

      case SituationType.SUBSCRIPTION_RENEWAL: {
        const service = subject ?? rawEvent['service'] ?? rawEvent['provider'];
        const serviceName = service ? `${String(service)}` : 'A subscription';
        const amount = rawEvent['amount'] ?? rawEvent['cost'];
        const amountStr = amount ? ` for ${String(amount)}` : '';
        return `${serviceName} renewal${amountStr} is pending.`;
      }

      case SituationType.GROCERY_REORDER: {
        const items = rawEvent['items'];
        const count = Array.isArray(items) ? items.length : 0;
        return count > 0
          ? `${count} grocery item(s) may need reordering.`
          : 'Grocery reorder may be needed.';
      }

      case SituationType.TRAVEL_DECISION: {
        const destination = rawEvent['destination'] ?? rawEvent['location'];
        const destStr = destination ? ` to ${String(destination)}` : '';
        return `Travel decision needed${destStr}.`;
      }

      case SituationType.GENERIC:
      default: {
        const desc = subject ?? rawEvent['description'] ?? rawEvent['type'];
        return desc
          ? `Decision needed regarding: ${String(desc)}.`
          : 'A decision is needed for an incoming event.';
      }
    }
  }
}
