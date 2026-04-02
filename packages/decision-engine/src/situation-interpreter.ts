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
      id: crypto.randomUUID(),
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
    const body = String(rawEvent['body'] ?? '').toLowerCase();

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

    // Finance operations
    if (
      type.includes('finance') ||
      type.includes('banking') ||
      type.includes('payment') ||
      type.includes('bill') ||
      type.includes('transaction') ||
      subject.includes('invoice') ||
      subject.includes('payment') ||
      subject.includes('charge') ||
      subject.includes('refund') ||
      subject.includes('transfer') ||
      body.includes('invoice') ||
      body.includes('payment') ||
      body.includes('charge') ||
      body.includes('refund') ||
      body.includes('transfer')
    ) {
      return SituationType.FINANCE_OPERATION;
    }

    // Smart home / IoT
    if (
      type.includes('smart_home') ||
      type.includes('iot') ||
      type.includes('home') ||
      subject.includes('thermostat') ||
      subject.includes('lights') ||
      subject.includes('door') ||
      subject.includes('alarm') ||
      subject.includes('sensor') ||
      subject.includes('temperature') ||
      body.includes('thermostat') ||
      body.includes('lights') ||
      body.includes('door') ||
      body.includes('alarm') ||
      body.includes('sensor') ||
      body.includes('temperature')
    ) {
      return SituationType.SMART_HOME;
    }

    // Task management
    if (
      type.includes('task') ||
      type.includes('todo') ||
      type.includes('project') ||
      subject.includes('deadline') ||
      subject.includes('assign') ||
      subject.includes('reminder') ||
      subject.includes('overdue') ||
      subject.includes('task') ||
      body.includes('deadline') ||
      body.includes('assign') ||
      body.includes('reminder') ||
      body.includes('overdue') ||
      body.includes('task')
    ) {
      return SituationType.TASK_MANAGEMENT;
    }

    // Social media
    if (
      type.includes('social') ||
      type.includes('twitter') ||
      type.includes('instagram') ||
      type.includes('facebook') ||
      subject.includes('mention') ||
      subject.includes('follower') ||
      subject.includes('comment') ||
      subject.includes('post') ||
      subject.includes('tweet') ||
      body.includes('mention') ||
      body.includes('follower') ||
      body.includes('comment') ||
      body.includes('post') ||
      body.includes('tweet')
    ) {
      return SituationType.SOCIAL_MEDIA;
    }

    // Document management
    if (
      type.includes('document') ||
      type.includes('file') ||
      type.includes('drive') ||
      subject.includes('shared') ||
      subject.includes('folder') ||
      subject.includes('permission') ||
      subject.includes('document') ||
      subject.includes('upload') ||
      body.includes('shared') ||
      body.includes('folder') ||
      body.includes('permission') ||
      body.includes('document') ||
      body.includes('upload')
    ) {
      return SituationType.DOCUMENT_MANAGEMENT;
    }

    // Health and wellness
    if (
      type.includes('health') ||
      type.includes('medical') ||
      type.includes('fitness') ||
      subject.includes('appointment') ||
      subject.includes('medication') ||
      subject.includes('prescription') ||
      subject.includes('symptom') ||
      subject.includes('doctor') ||
      subject.includes('lab') ||
      body.includes('appointment') ||
      body.includes('medication') ||
      body.includes('prescription') ||
      body.includes('symptom') ||
      body.includes('doctor') ||
      body.includes('lab')
    ) {
      return SituationType.HEALTH_WELLNESS;
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
      [SituationType.FINANCE_OPERATION]: 'finance',
      [SituationType.SMART_HOME]: 'smart_home',
      [SituationType.TASK_MANAGEMENT]: 'tasks',
      [SituationType.SOCIAL_MEDIA]: 'social',
      [SituationType.DOCUMENT_MANAGEMENT]: 'documents',
      [SituationType.HEALTH_WELLNESS]: 'health',
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
      [SituationType.FINANCE_OPERATION]: 'medium',
      [SituationType.SMART_HOME]: 'medium',
      [SituationType.TASK_MANAGEMENT]: 'low',
      [SituationType.SOCIAL_MEDIA]: 'low',
      [SituationType.DOCUMENT_MANAGEMENT]: 'low',
      [SituationType.HEALTH_WELLNESS]: 'medium',
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

      case SituationType.FINANCE_OPERATION: {
        const financeType = rawEvent['transactionType'] ?? rawEvent['type'];
        const amount = rawEvent['amount'] ?? rawEvent['cost'];
        const amountStr = amount ? ` of ${String(amount)}` : '';
        const typeStr = financeType ? `${String(financeType)}` : 'Financial operation';
        return `${typeStr}${amountStr} requires attention.`;
      }

      case SituationType.SMART_HOME: {
        const device = rawEvent['device'] ?? rawEvent['sensor'] ?? rawEvent['name'];
        const state = rawEvent['state'] ?? rawEvent['status'];
        const deviceStr = device ? `${String(device)}` : 'Smart home device';
        const stateStr = state ? ` is ${String(state)}` : ' triggered an event';
        return `${deviceStr}${stateStr}.`;
      }

      case SituationType.TASK_MANAGEMENT: {
        const taskName = subject ? `"${String(rawEvent['subject'] ?? rawEvent['title'] ?? rawEvent['name'])}"` : 'A task';
        const dueDate = rawEvent['dueDate'] ?? rawEvent['deadline'];
        const dueStr = dueDate ? ` (due ${String(dueDate)})` : '';
        return `${taskName}${dueStr} needs attention.`;
      }

      case SituationType.SOCIAL_MEDIA: {
        const platform = rawEvent['platform'] ?? rawEvent['source'];
        const action = rawEvent['action'] ?? rawEvent['type'];
        const platformStr = platform ? `on ${String(platform)}` : 'on social media';
        const actionStr = action ? `${String(action)} ` : 'Activity ';
        return `${actionStr}${platformStr} requires review.`;
      }

      case SituationType.DOCUMENT_MANAGEMENT: {
        const docName = rawEvent['fileName'] ?? rawEvent['title'] ?? rawEvent['name'];
        const docAction = rawEvent['action'] ?? rawEvent['type'];
        const docStr = docName ? `"${String(docName)}"` : 'A document';
        const actionStr = docAction ? ` was ${String(docAction)}` : ' needs attention';
        return `${docStr}${actionStr}.`;
      }

      case SituationType.HEALTH_WELLNESS: {
        const healthType = rawEvent['appointmentType'] ?? rawEvent['type'];
        const provider = rawEvent['provider'] ?? rawEvent['doctor'];
        const typeStr = healthType ? `${String(healthType)}` : 'Health event';
        const providerStr = provider ? ` with ${String(provider)}` : '';
        return `${typeStr}${providerStr} needs attention.`;
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
