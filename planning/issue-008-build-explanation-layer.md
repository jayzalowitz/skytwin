# Issue 008: Build the Explanation Layer

**Milestone:** [M1 -- Decision Core](./milestone-1-decision-core.md)
**Priority:** P0 (safety invariant)
**Estimate:** 2-3 days
**Assignee:** TBD
**Labels:** `explanations`, `audit`, `safety`, `M1`
**Depends on:** [Issue 001](./issue-001-bootstrap-repo.md), [Issue 002](./issue-002-define-core-schemas.md)

## Problem

Every action SkyTwin takes must be explainable. The user needs to understand what happened, why, what evidence was used, and how to correct it. Without explanations, the system is a black box -- and a black box that acts on your behalf is terrifying, not helpful.

## Why It Matters

This is a CLAUDE.md safety invariant: "Always log explanations. Every decision that results in an action (or a deliberate non-action) must produce an `ExplanationRecord`. If you can't explain it, don't do it."

Explanations serve three audiences:
1. **The user:** "Why did you archive that email?" needs a clear, human-readable answer.
2. **The system:** Structured explanation data feeds back into the eval harness (Issue 010) to measure decision quality.
3. **Debuggers:** When something goes wrong, the explanation audit trail is the primary debugging tool.

## Scope

### ExplanationGenerator API

The explanation layer lives in `@skytwin/explanations`:

```typescript
interface ExplanationGenerator {
  /**
   * Generate a complete explanation for a decision outcome.
   * This is called after the decision engine produces a DecisionOutcome.
   */
  explain(
    outcome: DecisionOutcome,
    context: DecisionContext,
    policyDecision: PolicyDecision
  ): Promise<ExplanationRecord>;

  /**
   * Generate an explanation for an escalation (when the system asks for approval).
   */
  explainEscalation(
    action: CandidateAction,
    context: DecisionContext,
    escalationReasons: string[]
  ): Promise<ExplanationRecord>;

  /**
   * Generate an explanation for a blocked action (when policy denies it).
   */
  explainDenial(
    action: CandidateAction,
    context: DecisionContext,
    policyDecision: PolicyDecision
  ): Promise<ExplanationRecord>;

  /**
   * Retrieve explanation records for a decision.
   */
  getExplanation(decisionId: string): Promise<ExplanationRecord | null>;

  /**
   * Retrieve explanation history for a user.
   */
  getUserExplanations(userId: string, limit?: number): Promise<ExplanationRecord[]>;
}
```

### ExplanationRecord Structure

Every explanation answers six questions:

```typescript
interface ExplanationRecord {
  id: string;
  decisionId: string;

  /** What happened? A one-sentence summary of the action taken (or not taken). */
  whatHappened: string;

  /** What evidence was used? The twin evidence records that informed the decision. */
  evidenceUsed: TwinEvidence[];

  /** What preferences were invoked? The preference keys that influenced the decision. */
  preferencesInvoked: string[];

  /** How confident was the system and why? */
  confidenceReasoning: string;

  /** Why this action over alternatives? */
  actionRationale: string;

  /** If escalated, why couldn't the system auto-decide? */
  escalationRationale: string | null;

  /** How can the user correct this if it's wrong? */
  correctionGuidance: string;

  createdAt: Date;
}
```

### Explanation Generation Rules

#### `whatHappened`

A single sentence describing the action in plain English:

- Auto-executed: "Archived the email from newsletters@store.com with subject 'Weekly sale'."
- Escalated: "Flagged for your review: a calendar conflict between 'Team standup' and 'Client call' on Tuesday at 2pm."
- Denied: "Blocked an attempt to auto-send a response to jane@company.com because the email domain is in your blocked list."
- No action: "Took no action on the subscription renewal for StreamingService ($14.99/month) because no preference was found."

#### `evidenceUsed`

The `TwinEvidence` records that were queried during decision-making:

- Preference records in the relevant domain
- Historical decisions in the same domain
- Feedback events that shaped the relevant preferences

Each evidence item should be traceable: "Preference 'email.newsletter.action = archive' was established from 7 feedback events over the last 30 days."

#### `preferencesInvoked`

The preference keys that were used:

- `email.newsletter.action` -- "Your preference to archive newsletters"
- `email.sender.vip_list` -- "Your VIP sender list (which does not include this sender)"
- `calendar.conflict.resolution_strategy` -- "Your preference to prioritize recurring meetings"

#### `confidenceReasoning`

Why the system was or wasn't confident:

- High confidence: "This matches a CONFIRMED preference with 15 consistent signals and no contradictions."
- Moderate confidence: "This matches an INFERRED preference based on 4 signals, but there is 1 contradicting signal from 3 weeks ago."
- Low confidence: "No strong preference found. Using default behavior for this domain."

#### `actionRationale`

Why this action was chosen over alternatives:

- "Chose 'archive' over 'delete' because you've never deleted a newsletter (0 deletes vs 34 archives). Chose 'archive' over 'label and keep' because you've only labeled 2 newsletters in the last 90 days."
- "Chose 'decline new meeting' over 'reschedule existing' because the existing meeting is a recurring 1:1 that you've attended 47/48 times."

This section should reference the other candidates that were considered and explicitly say why they were not selected.

#### `escalationRationale`

Only populated when the action was escalated (not auto-executed):

- "Escalated because this is the first time you've received an email from this sender, and no preference exists for this domain."
- "Escalated because the action cost ($45.00) exceeds your per-action spend limit ($25.00)."
- "Escalated because two preferences conflict: 'always attend meetings with VP' vs 'never skip weekly team standup'."

#### `correctionGuidance`

How the user can fix things if the explanation is wrong:

- "If this action was wrong, tap 'Undo' within 30 seconds to unarchive the email. To change this behavior, update your newsletter preference in Settings > Email > Newsletter handling."
- "To approve this action, tap 'Approve'. To change the subscription decision, tap 'Edit' and select your preferred option. Your choice will be remembered for future renewals."
- "To stop seeing these escalations, add 'newsletters' to your auto-archive domains in Settings > Email > Auto-archive."

### Output Formats

The explanation layer supports two output formats:

#### Human-Readable (Default)

A formatted text block suitable for display in a notification, email digest, or dashboard card:

```
[Action] Archived email from newsletters@store.com
[Subject] "Weekly sale - 40% off everything"
[Why] Matches your newsletter auto-archive preference (HIGH confidence, 34 consistent signals)
[Alternatives considered] Delete (not chosen: you've never deleted a newsletter), Label (not chosen: you rarely label newsletters)
[Undo] Tap to unarchive within 30 seconds
```

#### Structured (JSON)

The full `ExplanationRecord` as JSON, suitable for:
- Storage in CockroachDB
- Consumption by the eval harness
- API responses
- Debugging

### Persistence

Explanations are stored in the `explanation_records` table in CockroachDB:

- One record per decision (1:1 with `decisions` table)
- Indexed by `decision_id` for fast lookup
- `evidence_used` stored as JSONB array
- `preferences_invoked` stored as STRING array

### Explanation for Non-Actions

When the system decides to do nothing (no candidate passes all checks, or the "do nothing" candidate is selected), an explanation record is still created:

```
whatHappened: "Took no action on the incoming email."
actionRationale: "No candidate action had sufficient confidence to proceed. The highest-confidence action was 'archive' (MODERATE confidence), but your trust tier (SUGGEST) requires all actions to be approved, and the urgency was LOW, so no approval request was created."
correctionGuidance: "If you'd like SkyTwin to handle emails like this automatically, review the email and add a preference in Settings > Email."
```

## Implementation Notes

### Explanation Assembly

The generator doesn't make decisions -- it documents them. It receives the `DecisionOutcome`, `DecisionContext`, and `PolicyDecision` as inputs and assembles the explanation from their contents.

The key implementation challenge is generating good natural language from structured data. Strategies:

1. **Template-based:** Use templates per situation type with slot filling.
   - "Archived {action.target} from {sender} because {preference.description}."
   - Simple, deterministic, testable.
   - Downside: Repetitive, can't handle novel situations well.

2. **Rule-based composition:** Build explanation sentences by composing clauses based on which fields are populated.
   - "Chose {selectedAction} over {rejectedActions.join(', ')} because {reasons.join('; ')}."
   - More flexible than templates, still deterministic.

3. **LLM-generated (future):** Feed structured data to an LLM and ask for a natural language explanation.
   - Best quality, handles novel situations.
   - Non-deterministic, slower, more expensive.
   - M4 or later.

**M1 decision: Use template-based with rule-based composition as fallback.** Each situation type has templates for common explanations. Unusual explanations fall back to generic clause composition.

### Testing Strategy

1. **Template coverage:** Every situation type has at least one test that generates an explanation using a template.
2. **Field completeness:** Every `ExplanationRecord` field is non-empty (except `escalationRationale` for auto-executed actions).
3. **Consistency:** The `whatHappened` field matches the `DecisionOutcome.selectedAction`.
4. **Escalation explanations:** When an action is escalated, `escalationRationale` explains why.
5. **Denial explanations:** When an action is denied, the explanation says which policy blocked it.
6. **Correction guidance:** Every explanation includes actionable correction guidance.
7. **Persistence:** Explanations are stored in CockroachDB and retrievable by decision ID.

## Acceptance Criteria

- [ ] `ExplanationGenerator.explain(outcome, context, policyDecision)` produces a complete `ExplanationRecord`.
- [ ] `whatHappened` is a clear, one-sentence description of the action (or non-action).
- [ ] `evidenceUsed` lists the twin evidence records that were consulted.
- [ ] `preferencesInvoked` lists the preference keys that influenced the decision.
- [ ] `confidenceReasoning` explains the confidence level with reference to signal count and consistency.
- [ ] `actionRationale` explains why the selected action was chosen over at least one alternative.
- [ ] `escalationRationale` is populated when the action was escalated and explains the trigger.
- [ ] `correctionGuidance` tells the user how to undo, correct, or adjust preferences.
- [ ] Explanations are generated for escalated actions (via `explainEscalation`).
- [ ] Explanations are generated for denied actions (via `explainDenial`).
- [ ] Explanations are generated for "do nothing" outcomes.
- [ ] Both human-readable and structured formats are available.
- [ ] Explanations are persisted to the `explanation_records` table in CockroachDB.
- [ ] `getExplanation(decisionId)` retrieves the stored explanation.
- [ ] No explanation field is empty or null (except `escalationRationale` when not escalated).
- [ ] All tests pass: `pnpm --filter @skytwin/explanations test`.

## Non-Goals

- **LLM-generated explanations:** M1 uses templates. LLM explanations are future work.
- **Explanation quality scoring:** Whether an explanation is "good" is subjective. The eval harness (Issue 010) will measure completeness, not quality.
- **Multi-language explanations:** English only.
- **Rich formatting:** Explanations are plain text. Markdown, HTML, or rich media formatting is future work.
- **Interactive explanations:** The explanation tells the user what to do, but the interaction (tap undo, change settings) is handled by the API/web layer, not the explanation layer.

## Dependencies

- [Issue 001](./issue-001-bootstrap-repo.md): Workspace structure.
- [Issue 002](./issue-002-define-core-schemas.md): `ExplanationRecord`, `TwinEvidence`, `DecisionOutcome`, `DecisionContext`, `PolicyDecision` types and `explanation_records` table.
- [Issue 005](./issue-005-build-decision-engine.md): The decision engine produces the `DecisionOutcome` that the explanation layer documents. Integration testing requires both.

## Risks and Open Questions

| Item | Type | Notes |
|------|------|-------|
| Template-based explanations feel robotic | Risk | Accept for M1. The explanations are correct and complete, even if they're not prose-quality. LLM-generated explanations (future) will improve quality. |
| "Why not" explanations (why was alternative X rejected?) are hard to generate | Risk | The decision engine must pass the full set of `allCandidates` with reasons for rejection. If this data isn't available, the explanation can only say "the selected action had the highest confidence." |
| Explanation generation is on the critical path of every decision | Risk | Keep it fast. Template filling and DB write should take <50ms. If explanation generation is slow, it delays the decision response. |
| What should `correctionGuidance` say when there's no undo mechanism? | Open question | Decision: Always provide guidance, even if it's "This action cannot be undone. To prevent similar actions in the future, adjust your preferences in Settings > [Domain]." Honesty about irreversibility is better than silence. |
| Should explanations reference specific evidence IDs or describe them in English? | Open question | Decision: Both. `evidenceUsed` contains the full `TwinEvidence` objects (structured). `confidenceReasoning` describes them in English. Structured for machines, English for humans. |
