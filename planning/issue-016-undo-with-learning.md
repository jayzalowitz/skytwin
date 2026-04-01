# Issue 016: Undo-with-Learning

**Status:** Not started
**Milestone:** Phase 3C
**Estimate:** 1 day (human) / 10 min (CC)
**Depends on:** Phase 1 migrations (feedback_events extension), execution-router (011)
**CEO Review Decision:** #6 (extend feedback_events, unified stream)

## Goal

When a user undoes an action, capture their reasoning about what went wrong and feed it back to the twin model as a high-weight correction signal.

## Scope

### In scope
- Extended feedback recording in `@skytwin/twin-model`
- New feedbackType: 'undo' in addition to existing approve/reject/correct/ignore
- Capture: which execution step went wrong, user's reasoning, preferred alternative
- Trigger rollback via ExecutionRouter if action is reversible
- Feed reasoning back to twin model as high-weight correction (2x normal feedback weight)
- Undo reasoning stored in feedback_events.undo_reasoning JSONB column

### Out of scope
- Partial undo (undo specific steps within a multi-step execution)
- Automatic undo suggestions

## Implementation

### Extended FeedbackEvent
```typescript
interface UndoFeedback extends FeedbackEvent {
  feedbackType: 'undo';
  undoReasoning: {
    whatWentWrong: string;
    whichStep?: string;        // execution step ID
    preferredAlternative?: string;
    severity: 'minor' | 'moderate' | 'severe';
  };
}
```

### Flow
1. User clicks "Undo" on a completed action
2. UI prompts: "What went wrong?" + optional preferred alternative
3. System records UndoFeedback with reasoning
4. If action is reversible: trigger rollback via ExecutionRouter
5. If irreversible: log but cannot rollback, explain to user
6. Feed reasoning to twin model with 2x weight multiplier
7. InferenceEngine processes undo as strong contradicting evidence

## Success Criteria
1. Undo feedback captured with reasoning
2. Reversible actions rolled back on undo
3. Irreversible actions: undo logged, user informed
4. Twin model updated with 2x weight correction
5. Subsequent decisions reflect the undo learning
