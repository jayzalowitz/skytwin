# Issue 015: Preference Archaeology

**Status:** Not started
**Milestone:** Phase 3B
**Estimate:** 1-2 days (human) / 15 min (CC)
**Depends on:** Phase 1 migrations (preference_proposals table)
**CEO Review Decision:** #5 (separate preference_proposals table)

## Goal

Detect implicit preference patterns from the user's evidence and feedback history, then propose them as explicit rules the user can confirm or reject.

## Scope

### In scope
- `PreferenceArchaeologist` analyzer in `@skytwin/twin-model`
- Scans evidence + feedback history for recurring patterns
- Generates `PreferenceProposal` records in preference_proposals table
- GET /api/v1/preferences/:userId/proposals — list pending proposals
- POST /api/v1/preferences/:userId/proposals/:id — accept/reject
- On accept: creates real Preference with source='inferred'
- On reject: records as negative signal for twin learning
- Proposal expiry (30 days default)

### Out of scope
- ML-based pattern detection (rule-based for now)
- Proactive notification of new proposals (dashboard polling)

## Implementation

### PreferenceArchaeologist
```typescript
class PreferenceArchaeologist {
  async analyze(userId: string): Promise<PreferenceProposal[]> {
    const evidence = await twinRepo.getEvidence(userId);
    const feedback = await feedbackRepo.getByUserId(userId);
    const existingPrefs = await twinRepo.getPreferences(userId);

    // 1. Group evidence by (domain, action pattern)
    // 2. Require 5+ consistent occurrences
    // 3. Check not already an explicit preference
    // 4. Check not already proposed and rejected
    // 5. Generate proposal with supporting evidence
    return proposals;
  }
}
```

### Proposal Lifecycle
1. PENDING: archaeology detects pattern, creates proposal
2. ACCEPTED: user confirms → creates Preference(source='inferred')
3. REJECTED: user declines → records negative signal, won't repropose for 90 days
4. EXPIRED: 30 days without response → archived

## Success Criteria
1. Archaeology detects patterns from 5+ consistent evidence items
2. Proposals created with supporting evidence references
3. Accept flow creates real Preference
4. Reject flow prevents re-proposal for 90 days
5. Already-explicit preferences not re-proposed
