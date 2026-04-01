import type {
  PreferenceProposal,
  TwinEvidence,
} from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type { TwinRepositoryPort } from './twin-service.js';

/**
 * PreferenceArchaeologist analyzes historical evidence and feedback to
 * discover latent preferences the user has not explicitly stated. When a
 * consistent behavioral pattern is observed (>= 5 occurrences), the
 * archaeologist generates a PreferenceProposal for review.
 */
export class PreferenceArchaeologist {
  constructor(private readonly repository: TwinRepositoryPort) {}

  /**
   * Analyze a user's evidence history and generate proposals for
   * preferences that appear to exist but have not been explicitly set.
   */
  async analyze(userId: string): Promise<PreferenceProposal[]> {
    const evidence = await this.repository.getEvidence(userId, 500);
    await this.repository.getFeedback(userId, 500);
    const existingPreferences = await this.repository.getPreferences(userId);

    // Group evidence by domain:action pattern
    const groups = this.groupEvidence(evidence);

    const proposals: PreferenceProposal[] = [];

    for (const [groupKey, items] of groups) {
      // Only consider groups with 5+ consistent occurrences
      if (items.length < 5) continue;

      const [domain, action] = groupKey.split(':') as [string, string];

      // Skip if already an explicit preference
      const alreadyExplicit = existingPreferences.some(
        (p) => p.domain === domain && p.key === action && p.source === 'explicit',
      );
      if (alreadyExplicit) continue;

      const confidence = this.confidenceFromCount(items.length);

      const proposal: PreferenceProposal = {
        id: `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        userId,
        domain: domain!,
        key: action!,
        value: this.extractDominantValue(items),
        confidence,
        supportingEvidence: items.slice(0, 10).map((ev) => ({
          evidenceId: ev.id,
          summary: `${ev.type} in ${ev.domain} at ${ev.timestamp.toISOString()}`,
        })),
        status: 'pending',
        detectedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      };

      proposals.push(proposal);
    }

    return proposals;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Group evidence items by `domain:action` key extracted from evidence data.
   */
  private groupEvidence(evidence: TwinEvidence[]): Map<string, TwinEvidence[]> {
    const groups = new Map<string, TwinEvidence[]>();

    for (const ev of evidence) {
      const action = this.extractAction(ev);
      if (!action) continue;

      const key = `${ev.domain}:${action}`;
      const group = groups.get(key) ?? [];
      group.push(ev);
      groups.set(key, group);
    }

    return groups;
  }

  /**
   * Extract the action pattern from an evidence item's data.
   */
  private extractAction(ev: TwinEvidence): string | null {
    if (typeof ev.data['action'] === 'string') {
      return ev.data['action'];
    }
    if (typeof ev.data['preference_key'] === 'string') {
      return ev.data['preference_key'];
    }
    if (typeof ev.data['behavior'] === 'string') {
      return ev.data['behavior'];
    }
    return null;
  }

  /**
   * Extract the most common value from a group of evidence items.
   */
  private extractDominantValue(evidence: TwinEvidence[]): unknown {
    const valueCounts = new Map<string, { value: unknown; count: number }>();

    for (const ev of evidence) {
      const value = ev.data['action'] ?? ev.data['preference_value'] ?? ev.data['behavior'] ?? true;
      const key = JSON.stringify(value);
      const existing = valueCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        valueCounts.set(key, { value, count: 1 });
      }
    }

    let dominant: { value: unknown; count: number } = { value: true, count: 0 };
    for (const entry of valueCounts.values()) {
      if (entry.count > dominant.count) {
        dominant = entry;
      }
    }

    return dominant.value;
  }

  /**
   * Map evidence count to confidence level.
   * 5-9: LOW, 10-19: MODERATE, 20+: HIGH
   */
  private confidenceFromCount(count: number): ConfidenceLevel {
    if (count >= 20) return ConfidenceLevel.HIGH;
    if (count >= 10) return ConfidenceLevel.MODERATE;
    return ConfidenceLevel.LOW;
  }
}
