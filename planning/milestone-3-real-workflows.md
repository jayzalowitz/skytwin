# Milestone 3: Real Workflows

**Status:** Not Started
**Target:** Week 9-12
**Owner:** Core team + integrations team
**Depends on:** [Milestone 2 -- Safe Delegation](./milestone-2-safe-delegation.md)

## Goal

Wire up multiple realistic workflows through the complete SkyTwin pipeline: situation interpretation, twin lookup, decisioning, policy evaluation, execution via IronClaw, explanation generation, and persistence. After M3, the system can handle real-world scenarios end-to-end -- not just mock events, but actual structured inputs that exercise the full decision and execution path.

## Scope

### In scope

#### Production-Ready IronClaw Adapter

The mock adapter from M0 is replaced with a production-ready implementation:
- Real HTTP client with retry logic, exponential backoff, circuit breaker
- Request/response normalization into SkyTwin types
- Execution: send an action to IronClaw, receive status updates, handle completion/failure
- Status polling: check execution state for long-running actions
- Rollback: request action reversal for reversible actions
- Error classification: transient (retry) vs permanent (fail) vs partial (escalate)
- Clean integration boundary: no IronClaw types leak beyond the adapter package
- Configuration: base URL, API key, timeout, retry policy from `@skytwin/config`

#### Five Realistic Workflows

Each workflow is a complete vertical slice through the system:

**1. Email Triage**
- Signal: incoming email metadata (sender, subject, labels, thread context)
- Interpretation: classify urgency (spam, FYI, needs response, urgent), identify sender relationship
- Twin lookup: check sender preferences (VIP list, auto-archive rules, response templates)
- Decision: archive, label, draft response, flag for attention, or snooze
- Policy: check email domain permissions, response content sensitivity
- Execution: via IronClaw (apply label, move to folder, draft reply)
- Explanation: "Archived because sender is on your marketing list and subject matches newsletter pattern"

**2. Calendar Conflict Resolution**
- Signal: new calendar invite that overlaps with existing event
- Interpretation: identify conflict type (double-booking, travel overlap, focus time encroachment)
- Twin lookup: check meeting priorities, attendance patterns, preferred resolution strategies
- Decision: decline new invite, suggest alternative time, accept and reschedule existing, or escalate
- Policy: check calendar domain permissions, can't auto-decline meetings with certain attendees
- Execution: via IronClaw (send decline, propose new time, update calendar)
- Explanation: "Declined because it conflicts with your weekly 1:1 which you've never rescheduled"

**3. Subscription Renewal**
- Signal: upcoming subscription renewal notification
- Interpretation: identify service, renewal amount, current usage
- Twin lookup: check usage patterns, past renewal decisions, budget preferences
- Decision: auto-renew, cancel, downgrade, or escalate for review
- Policy: spend limit check against renewal amount, require approval for annual commitments
- Execution: via IronClaw (confirm renewal, initiate cancellation, change plan)
- Explanation: "Auto-renewed because you've used this service 28 of the last 30 days and it's under your $15/month threshold"

**4. Grocery Reorder**
- Signal: recurring grocery delivery window approaching, or detected low-stock signal
- Interpretation: identify items, check delivery window, compare against usual order
- Twin lookup: check dietary preferences, brand preferences, typical order composition, budget
- Decision: reorder usual items, suggest modifications based on recent patterns, or escalate
- Policy: total order spend check, check for items on restricted list
- Execution: via IronClaw (place order, modify cart, schedule delivery)
- Explanation: "Reordered your usual weekly basket minus the yogurt (you skipped it last 3 times) plus extra bananas (you've been ordering more)"

**5. Travel Preferences**
- Signal: upcoming trip detected (flight confirmation email, hotel booking)
- Interpretation: identify trip parameters (dates, destination, purpose)
- Twin lookup: check seat preferences, hotel chain loyalty, car rental preferences, per diem budget
- Decision: book preferred seat, reserve hotel, arrange transport, or escalate for complex trips
- Policy: travel spend limits, require approval for international trips or trips over $500
- Execution: via IronClaw (select seat, book hotel, reserve car)
- Explanation: "Selected aisle seat because you've chosen aisle 94% of the time; booked Marriott because of your loyalty status and it's $30 cheaper than alternatives"

#### Workflow Integration

Each workflow is wired through the same pipeline:

```
RawEvent → SituationInterpreter → DecisionObject
    → TwinService.getProfile() → DecisionContext
    → DecisionMaker.evaluate() → CandidateAction[] → RiskAssessment[]
    → PolicyEvaluator.evaluate() → filtered candidates
    → selectAction() → DecisionOutcome
    → ExplanationGenerator.explain() → ExplanationRecord
    → IronClawAdapter.execute() → ExecutionResult
    → Persist all records to CockroachDB
```

### Out of scope

- Real external service APIs (email via Gmail API, calendar via Google Calendar). IronClaw abstracts these.
- Natural language processing for email content. Use structured metadata only.
- ML-based preference inference. Use rule-based inference from M1.
- Mobile push notifications for approvals.
- Workflow designer UI.

## Success Criteria

1. **IronClaw adapter handles real HTTP patterns:** Tests demonstrate successful execution, retry on transient failure, circuit breaker on repeated failure, and rollback.
2. **Each workflow has an end-to-end integration test:** Five tests, one per workflow, that start with a raw event and end with a persisted `ExecutionResult` and `ExplanationRecord`.
3. **Workflows respect policies:** An email triage action that would send a response in a blocked domain is escalated. A grocery order exceeding the daily spend limit requires approval.
4. **IronClaw errors are handled gracefully:** A failed execution produces a clear error, does not leave the system in an inconsistent state, and creates an explanation record noting the failure.
5. **Rollback works:** A reversible action that the user later undoes triggers IronClaw rollback, and the system records the undo.
6. **No IronClaw types leak:** No package other than `@skytwin/ironclaw-adapter` imports IronClaw-specific types.
7. **All workflows produce complete explanations:** Every workflow's explanation answers: what happened, why, what preferences were used, and how to correct it.

## Issues

| Issue | Title | Status | Estimate |
|-------|-------|--------|----------|
| [007](./issue-007-build-ironclaw-adapter.md) | Build the IronClaw Adapter (production-ready) | Not started | 4-5 days |

Note: The five workflows are implemented as part of the situation interpreter (004, extended), decision engine (005, extended), and IronClaw adapter (007). They don't have separate issues because they're vertical slices that touch multiple packages rather than horizontal features in one package.

## Detailed Work Breakdown

| Work Item | Estimate | Dependencies |
|-----------|----------|--------------|
| IronClaw HTTP client with retry/circuit breaker | 2 days | M2 complete |
| IronClaw execution/status/rollback implementation | 2 days | HTTP client |
| Email triage workflow (interpreter + candidates + execution) | 1.5 days | IronClaw adapter |
| Calendar conflict workflow | 1.5 days | IronClaw adapter |
| Subscription renewal workflow | 1 day | IronClaw adapter |
| Grocery reorder workflow | 1 day | IronClaw adapter |
| Travel preferences workflow | 1 day | IronClaw adapter |
| Integration tests for all workflows | 2 days | All workflows |
| Error handling and edge case coverage | 1 day | All workflows |
| **Total** | **13-14 days** | |

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| IronClaw API contract is unstable or under-documented | High | Medium | Build the adapter against an interface; mock the HTTP layer; treat IronClaw API changes as adapter-only changes |
| Workflow complexity explodes when handling edge cases | High | High | Define a "happy path" for each workflow first; handle edge cases incrementally; use `generic` situation type as fallback |
| Five workflows in one milestone is too much scope | Medium | Medium | Prioritize email triage and calendar conflict (most common); defer grocery and travel if needed |
| Circuit breaker logic is hard to test deterministically | Medium | Low | Use a clock abstraction; test with controlled failure sequences |
| Rollback semantics differ per workflow | Medium | Medium | Define rollback as "best effort" for M3; some actions genuinely can't be undone (sent emails) |

## Architecture Notes

### IronClaw Adapter Design

```typescript
interface IronClawAdapter {
  execute(action: CandidateAction): Promise<ExecutionResult>;
  getStatus(executionId: string): Promise<ExecutionStatus>;
  rollback(executionId: string): Promise<RollbackResult>;
  healthCheck(): Promise<boolean>;
}
```

The adapter is the only package that knows about IronClaw's API format. It translates between SkyTwin's `CandidateAction` and IronClaw's execution API, and between IronClaw's response format and SkyTwin's `ExecutionResult`.

### Workflow Registration

Workflows are registered with the situation interpreter via a handler registry:

```typescript
interface WorkflowHandler {
  situationType: SituationType;
  interpret(rawEvent: RawEvent): DecisionObject;
  generateCandidates(context: DecisionContext): CandidateAction[];
}
```

Each workflow provides its own interpretation and candidate generation logic, but shares the common decision, policy, and explanation pipeline.

## Exit Criteria

M3 is complete when:
- All success criteria above are verified
- The IronClaw adapter passes contract tests against a mock server
- All five workflow integration tests are in CI and passing
- A developer can add a sixth workflow by implementing `WorkflowHandler` without modifying core pipeline code
