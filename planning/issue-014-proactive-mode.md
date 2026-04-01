# Issue 014: Proactive Mode + Morning Briefing

**Status:** Not started
**Milestone:** Phase 3A
**Estimate:** 2-3 days (human) / 20 min (CC)
**Depends on:** Phase 2B (whatWouldIDo reuses scoring), Phase 1 migrations
**CEO Review Decisions:** #2 (lives in decision-engine), #12 (dashboard-first), #13 (HIGH confidence for proactive)

## Goal

Transform SkyTwin from reactive to proactive. Periodically evaluate the user's full context, surface what needs doing, and generate a morning briefing.

## Scope

### In scope
- `ProactiveEvaluator` in `@skytwin/decision-engine`
- Full-context loading from all connected accounts
- Rank "what needs doing most" using existing scoring infrastructure
- Morning briefing generation (ranked actions, confidence, reasoning)
- `proactive_scans` table (scan runs, results)
- `briefings` table (briefing records with ranked items)
- Dashboard delivery with inline approve/reject/edit
- Email digest opt-in with deep links to dashboard
- Worker cron integration (configurable: daily + hourly for urgent)
- Safety: require HIGH confidence for any proactive auto-execution

### Out of scope
- Mobile push notifications
- Evening summary (future enhancement)

## Implementation

### ProactiveEvaluator
```typescript
class ProactiveEvaluator {
  async scanUser(userId: string): Promise<ProactiveScanResult> {
    // 1. Load all connected account signals
    // 2. For each signal, run through whatWouldIDo() pipeline
    // 3. Filter: only actions with HIGH confidence
    // 4. Rank by urgency × confidence × impact
    // 5. Group into: auto-execute, approval-needed, informational
    return { autoActions, approvalNeeded, briefingItems };
  }

  async generateBriefing(userId: string, scanResult: ProactiveScanResult): Promise<Briefing> {
    // Format ranked items with explanations
    // Include: what, why, confidence, action buttons
  }
}
```

### Worker Integration
- Cron: configurable per-user schedule (default: 7am local, hourly urgent scan)
- Respects quiet hours from AutonomySettings
- Logs scan results to proactive_scans table

### Dashboard Briefing View
- GET /api/v1/briefings/:userId → latest briefing
- Each item: action description, confidence, approve/reject/edit inline
- PUT /api/v1/briefings/:userId/preferences → schedule, format, email opt-in

## Success Criteria
1. Proactive scan loads full context and ranks actions
2. Only HIGH confidence actions considered for auto-execution
3. Morning briefing generated with ranked items and explanations
4. Dashboard endpoint returns briefing data
5. Worker cron fires on schedule and respects quiet hours
