# Issue 012: Twin Query API (whatWouldIDo)

**Status:** Not started
**Milestone:** Phase 2B
**Estimate:** 1-2 days (human) / 15 min (CC)
**Depends on:** Phase 1 migrations (decisions.source, explanation_records.type)
**CEO Review Decisions:** #3 (full pipeline, no execution), #7 (log as predictions), #9 (rate limiting)

## Goal

Implement `whatWouldIDo(userId, situation)` as the core product interface. Runs the full decision pipeline on a synthetic event without executing. Logs predictions for twin quality evaluation.

## Scope

### In scope
- `whatWouldIDo()` method in `@skytwin/decision-engine`
- Creates synthetic `DecisionObject` from user's situation description
- Runs full pipeline: interpret → candidates → risk → policy → outcome
- Logs `ExplanationRecord` with `type='prediction'`
- Logs `Decision` with `source='query'`
- POST `/api/v1/twin/:userId/ask` endpoint
- Token-scoped rate limiting (60/hr observer → 600/hr high_autonomy)

### Out of scope
- Converting predictions to actions ("ok do it" flow — future issue)

## API Contract

```
POST /api/v1/twin/:userId/ask
Authorization: Bearer <api-token>

{
  "situation": "I got an email from my boss asking me to review a doc by Friday",
  "domain": "email",           // optional
  "urgency": "medium"          // optional
}

Response 200:
{
  "predictedAction": { ... CandidateAction },
  "confidence": "high",
  "reasoning": "Based on your pattern of responding to boss emails within 2 hours...",
  "wouldAutoExecute": false,
  "policyNotes": "Trust tier requires approval for email replies",
  "alternativeActions": [ ... ],
  "predictionId": "uuid"
}
```

## Implementation

1. Add `whatWouldIDo(userId: string, situation: WhatWouldIDoRequest): Promise<WhatWouldIDoResponse>` to DecisionMaker
2. Internally: create synthetic DecisionObject → build DecisionContext → evaluate → generate explanation
3. Tag all persisted records with source='query' and type='prediction'
4. Add rate limiting middleware to API route
5. Rate limit tiers: OBSERVER=60/hr, SUGGEST=120/hr, LOW=240/hr, MODERATE=360/hr, HIGH=600/hr

## Success Criteria
1. POST /ask returns predicted action with confidence and reasoning
2. ExplanationRecord logged with type='prediction'
3. Rate limiting enforced per trust tier
4. Full pipeline runs (policy blocks visible in response)
