import { describe, it, expect } from 'vitest';
import { CrossDomainAnalyzer } from '../cross-domain-analyzer.js';
import type { Inference, BehavioralPattern } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

describe('CrossDomainAnalyzer', () => {
  const analyzer = new CrossDomainAnalyzer();

  it('returns empty array when no traits detected', () => {
    const traits = analyzer.detectTraits([], []);
    expect(traits).toHaveLength(0);
  });

  it('detects cautious_spender across domains', () => {
    const inferences: Inference[] = [
      {
        id: 'inf1', domain: 'subscriptions', key: 'spending_behavior',
        value: 'reject high costs', confidence: ConfidenceLevel.MODERATE,
        supportingEvidenceIds: ['e1'], contradictingEvidenceIds: [],
        reasoning: '', createdAt: new Date(), updatedAt: new Date(),
      },
    ];

    const patterns: BehavioralPattern[] = [
      {
        id: 'p1', userId: 'u1', patternType: 'habit',
        description: 'cancels subscriptions', observedAction: 'cancel_subscription',
        trigger: { domain: 'subscriptions', conditions: {} },
        frequency: 5, confidence: ConfidenceLevel.MODERATE,
        firstObservedAt: new Date(), lastObservedAt: new Date(), metadata: {},
      },
      {
        id: 'p2', userId: 'u1', patternType: 'habit',
        description: 'rejects travel bookings', observedAction: 'reject_booking',
        trigger: { domain: 'travel', conditions: {} },
        frequency: 3, confidence: ConfidenceLevel.LOW,
        firstObservedAt: new Date(), lastObservedAt: new Date(), metadata: {},
      },
    ];

    const traits = analyzer.detectTraits(inferences, patterns);
    const spender = traits.find((t) => t.traitName === 'cautious_spender');
    expect(spender).toBeDefined();
    expect(spender!.supportingDomains).toContain('subscriptions');
    expect(spender!.supportingDomains).toContain('travel');
  });

  it('detects routine_driven trait', () => {
    const patterns: BehavioralPattern[] = [
      {
        id: 'p1', userId: 'u1', patternType: 'habit',
        description: 'daily email archive', observedAction: 'archive',
        trigger: { domain: 'email', conditions: {} },
        frequency: 25, confidence: ConfidenceLevel.CONFIRMED,
        firstObservedAt: new Date(), lastObservedAt: new Date(), metadata: {},
      },
      {
        id: 'p2', userId: 'u1', patternType: 'habit',
        description: 'daily calendar check', observedAction: 'review',
        trigger: { domain: 'calendar', conditions: {} },
        frequency: 20, confidence: ConfidenceLevel.HIGH,
        firstObservedAt: new Date(), lastObservedAt: new Date(), metadata: {},
      },
    ];

    const traits = analyzer.detectTraits([], patterns);
    const routine = traits.find((t) => t.traitName === 'routine_driven');
    expect(routine).toBeDefined();
    expect(routine!.supportingDomains.length).toBeGreaterThanOrEqual(2);
  });

  it('requires evidence from at least 2 domains', () => {
    const patterns: BehavioralPattern[] = [
      {
        id: 'p1', userId: 'u1', patternType: 'habit',
        description: 'single domain habit', observedAction: 'archive',
        trigger: { domain: 'email', conditions: {} },
        frequency: 30, confidence: ConfidenceLevel.CONFIRMED,
        firstObservedAt: new Date(), lastObservedAt: new Date(), metadata: {},
      },
    ];

    const traits = analyzer.detectTraits([], patterns);
    // routine_driven requires 2+ domains
    const routine = traits.find((t) => t.traitName === 'routine_driven');
    expect(routine).toBeUndefined();
  });
});
