import type { BehavioralPattern, TwinEvidence } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

/**
 * Detects behavioral patterns (habits) from repeated user actions.
 * Groups evidence by (source, type, action) tuples and creates patterns
 * when the same action appears consistently for similar trigger contexts.
 */
export class PatternDetector {
  /**
   * Detect habit patterns from evidence history.
   */
  detectHabits(
    evidence: TwinEvidence[],
    existingPatterns: BehavioralPattern[],
  ): BehavioralPattern[] {
    const patternMap = new Map<string, BehavioralPattern>();

    // Index existing patterns
    for (const pattern of existingPatterns) {
      const key = `${pattern.trigger.domain}:${pattern.trigger.source}:${pattern.observedAction}`;
      patternMap.set(key, pattern);
    }

    // Group evidence by (domain, source, action)
    const groups = new Map<string, TwinEvidence[]>();
    for (const ev of evidence) {
      const action = ev.data['action'] as string ?? ev.data['behavior'] as string ?? ev.type;
      const key = `${ev.domain}:${ev.source}:${action}`;
      const group = groups.get(key) ?? [];
      group.push(ev);
      groups.set(key, group);
    }

    // Create or update patterns from groups
    for (const [key, group] of groups) {
      if (group.length < 3) continue; // Need at least 3 occurrences

      const existing = patternMap.get(key);
      const [domain, source, action] = key.split(':') as [string, string, string];
      const timestamps = group.map((e) => e.timestamp);
      const earliest = new Date(Math.min(...timestamps.map((t) => t.getTime())));
      const latest = new Date(Math.max(...timestamps.map((t) => t.getTime())));

      // Detect sender-based contextual patterns
      const senders = group
        .map((e) => e.data['from'] as string)
        .filter(Boolean);
      const uniqueSenders = new Set(senders);
      const senderPattern = uniqueSenders.size === 1 ? senders[0] : undefined;

      if (existing) {
        // Update existing pattern
        existing.frequency = Math.max(existing.frequency, group.length);
        existing.lastObservedAt = latest;
        existing.confidence = this.frequencyToConfidence(existing.frequency);
        if (senderPattern) {
          existing.trigger.senderPattern = senderPattern;
        }
      } else {
        // Create new pattern
        const pattern: BehavioralPattern = {
          id: `pat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          userId: group[0]!.userId,
          patternType: senderPattern ? 'contextual' : 'habit',
          description: `User consistently performs "${action}" for ${source} signals in ${domain}`,
          trigger: {
            domain,
            source,
            senderPattern,
            conditions: {},
          },
          observedAction: action,
          frequency: group.length,
          confidence: this.frequencyToConfidence(group.length),
          firstObservedAt: earliest,
          lastObservedAt: latest,
          metadata: {
            sampleEvidenceIds: group.slice(0, 5).map((e) => e.id),
          },
        };
        patternMap.set(key, pattern);
      }
    }

    return Array.from(patternMap.values());
  }

  private frequencyToConfidence(frequency: number): ConfidenceLevel {
    if (frequency >= 20) return ConfidenceLevel.CONFIRMED;
    if (frequency >= 10) return ConfidenceLevel.HIGH;
    if (frequency >= 5) return ConfidenceLevel.MODERATE;
    if (frequency >= 3) return ConfidenceLevel.LOW;
    return ConfidenceLevel.SPECULATIVE;
  }
}
