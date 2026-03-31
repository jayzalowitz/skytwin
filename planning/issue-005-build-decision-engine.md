# Issue 005: Build the Decision Engine

**Milestone:** [M1 -- Decision Core](./milestone-1-decision-core.md)
**Priority:** P0 (core system)
**Estimate:** 3-4 days
**Assignee:** TBD
**Labels:** `decision-engine`, `core`, `M1`
**Depends on:** [Issue 003](./issue-003-build-twin-model.md), [Issue 004](./issue-004-build-situation-interpreter.md), [Issue 006](./issue-006-build-policy-engine.md)

## Problem

The system needs to take a structured `DecisionObject` (from the situation interpreter), enrich it with twin profile data, generate candidate actions, assess risk for each, run candidates through policy evaluation, select the best action, and determine whether to auto-execute or escalate. This is the brain of SkyTwin.

## Why It Matters

The decision engine is where judgment happens. It's the difference between a notification system ("you have a calendar conflict") and a delegation system ("I declined the meeting because you never skip your weekly 1:1"). Without a working decision engine, SkyTwin has no reason to exist.

The quality of this engine -- how well it generates candidates, how accurately it assesses risk, how reliably it selects the right action -- determines the value of the entire system.

## Scope

### DecisionMaker API

The decision engine lives in `@skytwin/decision-engine`:

```typescript
interface DecisionMaker {
  evaluate(context: DecisionContext): Promise<DecisionOutcome>;
}
```

One method. It takes everything it needs as input and produces a decision. No side effects other than persistence.

### Decision Pipeline

The `evaluate` method runs a five-stage pipeline:

#### Stage 1: Context Enrichment

The `DecisionContext` arrives with the user's `DecisionObject`, trust tier, and relevant preferences. The engine may augment this with:

- Historical decisions in the same domain (last N decisions for this user in this domain)
- Historical approval/rejection patterns
- Current daily spend total (for spend limit calculations)

```typescript
interface EnrichedContext extends DecisionContext {
  decisionHistory: DecisionOutcome[];  // Last N decisions in this domain
  dailySpendCents: number;             // Already spent today
  feedbackHistory: FeedbackSummary;    // Approval rate, common corrections
}
```

#### Stage 2: Candidate Generation

Given the enriched context, generate `CandidateAction[]` -- the set of possible responses:

```typescript
interface CandidateGenerator {
  generate(context: EnrichedContext): Promise<CandidateAction[]>;
}
```

Candidate generation is **situation-type-specific**. Each `SituationType` has a registered generator:

- **Email triage:** Candidates include archive, label, draft response, flag, snooze, delete, do nothing.
- **Calendar conflict:** Candidates include decline new, reschedule existing, accept both (overlap), suggest alternative time, do nothing.
- **Subscription renewal:** Candidates include auto-renew, cancel, downgrade, upgrade, do nothing.
- **Grocery reorder:** Candidates include reorder same, modify (add/remove items), skip this week, do nothing.
- **Travel decision:** Candidates include book preferred, book cheapest, book closest to preference, do nothing.
- **Generic:** Candidates include escalate to user, do nothing.

Each candidate includes:
- `estimatedCostCents`: Financial impact (0 for cost-neutral actions like archiving)
- `reversible`: Whether the action can be undone
- `confidence`: How sure the engine is that this matches user preference
- `reasoning`: Why this candidate was generated

#### Stage 3: Risk Assessment

Every candidate action is assessed across all six `RiskDimension`s:

```typescript
interface RiskAssessor {
  assess(action: CandidateAction, context: EnrichedContext): Promise<RiskAssessment>;
}
```

For each dimension:
- **Score:** 0.0 (no risk) to 1.0 (maximum risk)
- **Tier:** Mapped from score: 0-0.2 NEGLIGIBLE, 0.2-0.4 LOW, 0.4-0.6 MODERATE, 0.6-0.8 HIGH, 0.8-1.0 CRITICAL
- **Reasoning:** Text explanation of why this score was given

Dimension-specific rules:

| Dimension | Low risk example | High risk example |
|-----------|-----------------|-------------------|
| REVERSIBILITY | Archive an email (can unarchive) | Send a response (can't unsend) |
| FINANCIAL_IMPACT | $0 action | $500 subscription renewal |
| LEGAL_SENSITIVITY | Label an email | Sign a contract |
| PRIVACY_SENSITIVITY | Reorder groceries | Share calendar with external party |
| RELATIONSHIP_SENSITIVITY | Auto-archive newsletter | Decline meeting with manager |
| OPERATIONAL_RISK | Routine grocery order | Cancel a flight |

Overall risk tier = max(dimension tiers). If any dimension is CRITICAL, overall is CRITICAL.

#### Stage 4: Policy Evaluation

Run each candidate through the `PolicyEvaluator` (from `@skytwin/policy-engine`):

```typescript
const policyResults = await Promise.all(
  candidates.map(c => policyEvaluator.evaluate(c, context))
);
```

Policy evaluation filters candidates:
- `allow`: Candidate can proceed
- `deny`: Candidate is removed from consideration
- `require_approval`: Candidate is kept but marked as requiring approval

After policy evaluation, only allowed and require-approval candidates remain.

#### Stage 5: Action Selection

From the remaining candidates, select the best action:

```typescript
interface ActionSelector {
  select(candidates: PolicyEvaluatedCandidate[], context: EnrichedContext): Promise<SelectedAction>;
}
```

Selection criteria (in priority order):
1. **Safety first:** If all remaining candidates require approval, select the one with highest confidence and create an approval request.
2. **Preference alignment:** Among allowed candidates, pick the one that best matches the user's preferences (highest confidence from the candidate generator).
3. **Risk minimization:** Among equally-preferred candidates, pick the one with the lowest overall risk.
4. **Cost minimization:** Among equally-risky candidates, pick the cheapest.
5. **Do nothing:** If no candidate passes the above, select "do nothing" and escalate.

The selection result includes:
- `selectedAction`: The chosen `CandidateAction` (or null if "do nothing")
- `autoExecute`: Whether the system should execute without user approval
- `requiresApproval`: Whether the user needs to approve before execution
- `reasoning`: Why this action was selected over alternatives

### Auto-Execute Determination

The decision engine determines `autoExecute` based on:

| Condition | autoExecute |
|-----------|-------------|
| User trust tier is OBSERVER | false |
| User trust tier is SUGGEST | false |
| Action requires approval (from policy) | false |
| Action risk > user's trust tier allows | false |
| Action cost > user's per-action spend limit | false |
| Action cost would exceed daily spend limit | false |
| Action is irreversible AND user requires approval for irreversible | false |
| Action domain is in user's blocked domains | false (action should be denied, not auto-executed) |
| All checks pass | true |

### Persistence

The decision engine persists all results to CockroachDB:

1. `decisions` table: The interpreted situation
2. `candidate_actions` table: All generated candidates
3. `decision_outcomes` table: The selected action and auto-execute determination
4. `approval_requests` table: If approval is required

All persistence happens in a single transaction.

## Implementation Notes

### Pluggable Generators and Assessors

Use a registry pattern for candidate generators and risk assessors:

```typescript
class DecisionEngineImpl implements DecisionMaker {
  private generators: Map<SituationType, CandidateGenerator>;
  private assessor: RiskAssessor;
  private selector: ActionSelector;
  private policyEvaluator: PolicyEvaluator;

  registerGenerator(type: SituationType, generator: CandidateGenerator): void;
}
```

This allows adding new situation types without modifying the engine core.

### Candidate Quality

In M1, candidates are generated from fixed rules. For example, the email triage generator always produces the same set of candidate actions (archive, label, flag, etc.) and sets confidence based on simple heuristic matching against preferences.

Future milestones may introduce LLM-based candidate generation, where the engine asks an LLM "given this email and these preferences, what would the user do?"

### Testing Strategy

1. **Unit tests per stage:** Test each pipeline stage independently with mock inputs.
2. **End-to-end pipeline test:** Feed a raw event through the full pipeline (interpreter -> engine -> explanation) and verify the output.
3. **Risk assessment boundary tests:** Verify that score-to-tier mapping is correct at boundaries.
4. **Policy interaction tests:** Verify that denied candidates are filtered, require-approval candidates are flagged.
5. **Selection priority tests:** Given candidates with different confidence/risk/cost profiles, verify correct selection.
6. **Auto-execute tests:** One test per condition in the auto-execute truth table.

## Acceptance Criteria

- [ ] `DecisionMaker.evaluate(context)` produces a `DecisionOutcome` with a selected action for each situation type.
- [ ] At least 3 candidate actions are generated for email triage and calendar conflict situations.
- [ ] Every candidate action has a `RiskAssessment` with all six dimensions scored.
- [ ] Risk tier mapping follows the defined score-to-tier rules (tested at boundaries).
- [ ] Candidates denied by policy are excluded from selection.
- [ ] Candidates marked `require_approval` by policy produce `DecisionOutcome` with `requiresApproval: true`.
- [ ] The selection algorithm prefers higher confidence, then lower risk, then lower cost.
- [ ] `autoExecute` is `false` for OBSERVER and SUGGEST trust tiers, regardless of action risk.
- [ ] `autoExecute` is `false` when action cost exceeds spend limit.
- [ ] An irreversible action with `requireApprovalForIrreversible: true` always produces `requiresApproval: true`.
- [ ] The decision, all candidates, and the outcome are persisted to CockroachDB in a single transaction.
- [ ] The "do nothing" fallback works: when no candidate passes all checks, the outcome has `selectedAction: null` and `requiresApproval: true`.
- [ ] End-to-end test passes: mock email event -> interpreter -> engine -> decision outcome with explanation.
- [ ] All tests pass: `pnpm --filter @skytwin/decision-engine test`.

## Non-Goals

- **LLM-based candidate generation:** M1 uses rule-based generation only.
- **Multi-step action planning:** Each decision produces a single action, not a sequence. Multi-step plans are future work.
- **Asynchronous execution:** The engine decides what to do. Execution is a separate concern (M3, Issue 007).
- **Explanation generation:** The engine produces `reasoning` strings. The full `ExplanationRecord` is generated by the explanation layer (Issue 008).
- **Learning from outcomes:** The engine does not update the twin based on outcomes. That's the feedback loop (M4, Issue 009).

## Dependencies

- [Issue 003](./issue-003-build-twin-model.md): `TwinService` for profile and preference lookup.
- [Issue 004](./issue-004-build-situation-interpreter.md): `SituationInterpreter` for `DecisionObject` creation.
- [Issue 006](./issue-006-build-policy-engine.md): `PolicyEvaluator` for candidate filtering.
- [Issue 002](./issue-002-define-core-schemas.md): All shared types.

## Risks and Open Questions

| Item | Type | Notes |
|------|------|-------|
| Candidate generation quality is low without LLM | Risk | M1 candidates are from fixed rule sets. They'll cover common cases but miss nuance. Accept this; LLM integration is future work. |
| Risk assessment is subjective | Risk | Start with deterministic rules. Two engineers should agree on every risk score. Document the rules explicitly. Make scoring a pure function of inputs. |
| Selection algorithm may be too simplistic | Risk | Confidence > risk > cost ordering works for simple cases. Complex scenarios (e.g., moderate confidence + low risk vs high confidence + moderate risk) need more sophisticated selection. Accept M1 simplicity; tune in M4 with eval data. |
| Pipeline stages create performance overhead | Risk | Five stages with database reads is not free. For M1, acceptable. Profile caching and parallel risk assessment can improve performance later. |
| Should "do nothing" be a candidate or a special case? | Open question | Decision: "do nothing" is always an implicit candidate. It's the fallback when no other candidate passes all checks. It's not generated by the candidate generator; it's the engine's default when nothing else works. |
| How to handle ties in selection? | Open question | Decision: When two candidates are equal on all selection criteria, pick the first one (stable ordering). Log a warning about the tie for future investigation. |
