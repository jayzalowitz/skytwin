# Issue 017: Cross-Domain Correlation Engine (Foundation)

**Status:** Not started
**Milestone:** Phase 4
**Estimate:** 1 week time-box (human) / 30 min (CC)
**Depends on:** Phase 1 migrations (signals table), twin-model patterns
**CEO Review Decision:** #4 (signals table in CRDB), #13 (time-boxed to 1 week)

## Goal

Build the foundation for cross-domain event correlation. Store raw signals, detect when events across different domains are related, and enrich DecisionContext with cross-domain intelligence.

**TIME-BOXED: 1 week. Ship whatever's done. Foundation only — not a general-purpose CEP.**

## Scope

### In scope
- Signal persistence in `signals` table with 30-day retention
- `SignalStore` repository in `@skytwin/db`
- `CrossDomainCorrelator` in `@skytwin/twin-model` or `@skytwin/decision-engine`
- Basic correlation rules:
  - Email mentions a calendar event → link them
  - Email from same sender within 24h → thread them
  - Calendar conflict detection (two events at same time)
  - Subscription email + upcoming charge → link to financial context
- Correlation results feed into DecisionContext enrichment
- Correlation stored as metadata on the Decision record

### Out of scope (even within time-box)
- ML-based correlation
- Temporal pattern mining across domains
- Real-time streaming correlation
- General-purpose complex event processing

## Implementation

### SignalStore
```typescript
interface SignalStore {
  persist(signal: RawSignal & { userId: string }): Promise<void>;
  getRecent(userId: string, domain?: string, hours?: number): Promise<StoredSignal[]>;
  getRelated(signalId: string): Promise<StoredSignal[]>;
  cleanup(olderThanDays: number): Promise<number>; // TTL enforcement
}
```

### CrossDomainCorrelator
```typescript
class CrossDomainCorrelator {
  async findCorrelations(
    userId: string,
    currentSignal: RawSignal,
    lookbackHours: number = 48
  ): Promise<Correlation[]> {
    const recentSignals = await signalStore.getRecent(userId, undefined, lookbackHours);
    // Apply correlation rules
    // Return matched correlations with confidence
  }
}
```

### Correlation Rules (priority order for time-box)
1. **Calendar-Email link**: Email subject mentions calendar event title
2. **Same-sender threading**: Multiple emails from same sender within 24h
3. **Calendar conflict**: Two events overlapping in time
4. **Subscription-financial**: Subscription renewal email + known recurring charge

## Success Criteria
1. Signals persisted to signals table
2. At least 2 correlation rules implemented and tested
3. 30-day retention cleanup works
4. Correlations enrich DecisionContext
5. Shipped within 1-week time-box (whatever's done)
