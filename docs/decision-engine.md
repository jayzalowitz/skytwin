# SkyTwin Decision Engine

## Overview

The decision engine is the judgment core of SkyTwin. Given an event that has been classified as a decision opportunity, it:

1. Builds the decision context (twin profile, policies, history)
2. Generates candidate actions
3. Assesses risk for each candidate
4. Predicts user preference using the twin model
5. Selects the best action
6. Determines whether to auto-execute or escalate

The engine lives in `@skytwin/decision-engine` and depends on `@skytwin/shared-types`, `@skytwin/twin-model`, `@skytwin/policy-engine`, and `@skytwin/core`.

## How Situations Are Interpreted

Before the decision engine runs, the **situation interpreter** transforms raw events into `DecisionObject` instances. This is a classification step, not a judgment step -- it determines *what kind* of decision this is, not *what to do*.

### Situation Types

| Type | Trigger | Key Fields |
|------|---------|-----------|
| `email_triage` | New email received | Sender, subject, priority signals, reply expectation |
| `calendar_conflict` | Overlapping calendar events | Both events, participant lists, recurrence patterns |
| `subscription_renewal` | Renewal notice or billing event | Service, price, usage data, renewal date |
| `grocery_reorder` | Reorder window or cadence trigger | Previous order, price changes, availability |
| `travel_decision` | Trip approaching, options available | Destination, dates, options, preferences match |
| `generic` | Anything that doesn't fit above | Raw event data, best-effort classification |

### Interpretation Process

```
Raw Event
    |
    v
[Domain Classification] -- which domain does this belong to?
    |
    v
[Situation Type Matching] -- does it match a known pattern?
    |
    v
[Urgency Assessment] -- how time-sensitive is this?
    |   critical: must act within minutes (deadline < 1 hour)
    |   high: should act within hours (deadline < 4 hours)
    |   medium: can wait a day (deadline < 24 hours)
    |   low: no time pressure
    |
    v
[Metadata Extraction] -- pull out structured fields from raw event
    |
    v
DecisionObject
```

The interpreter uses heuristic rules per domain. It does not use LLM inference for classification (at this stage) -- classification should be fast, deterministic, and testable.

### Handling Unknown Situations

If a raw event doesn't match any known situation type, it is classified as `generic` with urgency `low`. The decision engine will escalate `generic` situations by default, since it has no candidate generation logic for unknown situation types.

This is intentional: the system should not fabricate responses to situations it doesn't understand. Adding new situation types is a development task, not a runtime capability.

## How Candidates Are Generated

Once a `DecisionObject` exists, the engine generates `CandidateAction[]` -- the set of possible things the system could do.

### Per-Situation Candidate Generation

Each situation type has a dedicated candidate generator:

**Email Triage Candidates:**
- `archive_email` -- archive the email for later review
- `label_email` -- apply appropriate labels based on content analysis
- `send_reply` -- send a brief acknowledgment reply (only generated when the email requires a response)

**Calendar Conflict Candidates:**
- `accept_invite` -- accept the calendar invitation
- `decline_invite` -- decline the calendar invitation
- `propose_alternative` -- propose an alternative time for the meeting

**Subscription Renewal Candidates:**
- `renew_subscription` -- renew the subscription at the listed price
- `cancel_subscription` -- cancel the subscription
- `snooze_reminder` -- snooze the renewal reminder for 3 days

**Grocery Reorder Candidates:**
- `place_order` -- reorder the listed grocery items
- `add_to_list` -- add items to the shopping list without placing an order

**Travel Decision Candidates:**
- `book_travel` -- book the travel arrangement
- `save_option` -- save the travel option for later review

### Candidate Enrichment

Each candidate is enriched with:

1. **Risk assessment** (see next section)
2. **Predicted user preference** from the twin model
3. **Reversibility classification**
4. **Estimated cost** (if applicable)
5. **Required trust tier** (minimum tier to auto-execute this action)

## How Risk Is Assessed

Every candidate action receives a `RiskAssessment` with scores across six dimensions. The risk assessment is deterministic based on action type, parameters, and context -- not a probability estimate from a model.

### Risk Assessment Process

```
CandidateAction
    |
    v
[Per-Dimension Scoring]
    |-- Reversibility: based on action type + domain rules
    |-- Financial Impact: based on estimatedCost
    |-- Legal Sensitivity: based on action type + domain rules
    |-- Privacy Sensitivity: based on data involved
    |-- Relationship Sensitivity: based on recipients/contacts involved
    |-- Operational Risk: based on action scope and blast radius
    |
    v
[Overall Tier Calculation]
    |-- Overall = max(all dimension tiers)
    |-- Additionally: if 3+ dimensions are MODERATE or above, elevate to at least HIGH
    |-- Rationale: a single CRITICAL dimension makes the action CRITICAL overall,
    |              and accumulated moderate risks across many dimensions are treated as high
    |
    v
[Confidence Score]
    |-- How confident is the risk assessment itself?
    |-- Lower confidence → more conservative treatment
    |
    v
RiskAssessment
```

### Dimension Scoring Rules

Risk scores are computed from explicit rules, not learned. Examples:

```
"send email" → relationship_sensitivity = at least MODERATE
"spend money" → financial_impact = based on amount vs spend norms
"delete anything" → reversibility = CRITICAL
"schedule change" → operational_risk = LOW for recurring, MODERATE for one-off
"auto-reply" → privacy_sensitivity = MODERATE (might expose context)
```

The rules are defined per domain and action type. They can be extended as new domains are added.

### Overall Risk Tier

The overall risk tier is the **maximum** across all dimensions, with one additional rule: if **3 or more** dimensions score MODERATE or above, the overall tier is elevated to at least HIGH even if no single dimension reaches HIGH on its own. This is conservative by design -- a single high-risk dimension elevates the entire action, and accumulated moderate risks across many dimensions are also treated seriously. Rationale: an action that is financially negligible but privacy-critical is still critical, and an action that is moderately risky on many fronts at once deserves elevated scrutiny.

## How the Twin Profile Informs Decisions

The twin profile is not just a reference -- it is the primary input for preference prediction.

### Preference Lookup

For each candidate action, the engine queries the twin for relevant preferences:

```
CandidateAction: "archive email from sender X"
    |
    v
Twin Query: "Does the user have a preference for emails from sender X?"
    |
    ├── Exact match: Preference "archive newsletters from sender X" → CONFIRMED
    ├── Category match: Preference "archive all newsletters" → HIGH
    ├── Pattern match: User has archived 15 of last 20 emails from X → MODERATE
    ├── Weak signal: One or two data points, not yet reliable → LOW
    └── No match: No relevant evidence → SPECULATIVE
```

### Confidence Levels in Practice

The engine uses confidence levels to set auto-execution thresholds:

| Confidence Level | Can Auto-Execute? |
|---------------------|-------------------|
| `CONFIRMED` | Yes, if trust tier and policy allow |
| `HIGH` | Yes, if trust tier and policy allow |
| `MODERATE` | Yes, if risk tier is within trust tier allowance |
| `LOW` | Never auto-execute. Confidence rank is below the MODERATE threshold. |
| `SPECULATIVE` | Never auto-execute. Confidence rank is below the MODERATE threshold. |

### Evidence Weighting

When multiple pieces of evidence exist, the engine considers:

1. **Recency:** Recent evidence is weighted more heavily than old evidence
2. **Explicitness:** Explicit user statements outweigh behavioral inference
3. **Consistency:** Consistent evidence across many events is stronger than one data point
4. **Contradiction:** If evidence conflicts, confidence drops and the system escalates

### Spend Norm Comparison

For actions with financial impact, the engine compares estimated cost against the user's spend norms:

```
Estimated cost: $15.99
Spend norm for "streaming subscriptions": $20/month
Ratio: 0.80 (within norms)
→ Financial risk: LOW

Estimated cost: $45.00
Spend norm for "streaming subscriptions": $20/month
Ratio: 2.25 (significantly above norms)
→ Financial risk: HIGH, escalate regardless of twin preference
```

## How Policies Constrain Choices

After the decision engine selects a preferred candidate, the **policy engine** evaluates it. The policy engine has veto power.

### Policy Evaluation Order

```
Selected CandidateAction
    |
    v
[1. Domain Check]
    |-- Is this domain in the user's allowed list?
    |-- Is this domain in the user's blocked list?
    |-- If blocked → DENY, no further checks
    |
    v
[2. Trust Tier Check]
    |-- Does the user's trust tier allow this action type?
    |-- OBSERVER/SUGGEST → always require approval
    |-- LOW_AUTONOMY → only low-risk, reversible actions
    |-- etc.
    |
    v
[3. Spend Limit Check]
    |-- Per-action spend limit
    |-- Daily spend limit
    |-- Domain spend limit
    |-- All must pass
    |
    v
[4. Reversibility Check]
    |-- If irreversible AND user requires approval for irreversible → REQUIRE_APPROVAL
    |
    v
[5. Policy Rule Evaluation]
    |-- Evaluate all active ActionPolicy rules in priority order
    |-- First matching rule's effect applies (allow/deny/require_approval)
    |-- If no rule matches → default to REQUIRE_APPROVAL
    |
    v
[6. Hardcoded Safety Checks]
    |-- The "never do without approval" list (see safety-model.md)
    |-- These override all other policy evaluations
    |
    v
Policy Verdict: ALLOW | DENY | REQUIRE_APPROVAL
```

### Policy Override Precedence

From highest to lowest priority:
1. Hardcoded safety invariants (always enforced)
2. User's explicit block list
3. Specific `ActionPolicy` rules
4. Trust tier constraints
5. Spend limits
6. Domain allow list
7. Default behavior (require approval)

## How Confidence and Trust Tier Affect Auto-Execution

The `shouldAutoExecute` method applies two checks in sequence:

### 1. Confidence Gate

The candidate's `ConfidenceLevel` must rank at or above `MODERATE`. If the confidence is `LOW` or `SPECULATIVE`, the action is never auto-executed regardless of trust tier or risk.

### 2. Risk-vs-Trust-Tier Comparison

If the confidence gate passes, the overall risk tier of the action is compared against what the user's trust tier allows:

| Trust Tier | Max Auto-Executable Risk Tier |
|---|---|
| `OBSERVER` | Never auto-execute |
| `SUGGEST` | Never auto-execute |
| `LOW_AUTONOMY` | `LOW` or below |
| `MODERATE_AUTONOMY` | `MODERATE` or below |
| `HIGH_AUTONOMY` | `HIGH` or below |

If the action's overall risk tier exceeds the maximum for the user's trust tier, the action escalates instead of auto-executing.

This design is intentionally conservative. The two gates are independent: a `CONFIRMED`-confidence action with `HIGH` risk still escalates for a `LOW_AUTONOMY` user, and a `LOW`-confidence action with `NEGLIGIBLE` risk still escalates because it fails the confidence gate.

## Decision Flow Diagram

```
Event Arrives
    |
    v
[Situation Interpreter]
    |-- classify situation type
    |-- assess urgency
    |-- extract metadata
    |
    v
DecisionObject created
    |
    v
[Load Decision Context]
    |-- fetch TwinProfile (current version)
    |-- fetch applicable ActionPolicies
    |-- fetch user TrustTier
    |-- fetch relevant history (recent decisions in this domain)
    |-- retrieve episodic memories from Memory Palace (similar past episodes)
    |-- load wake-up context (L0 identity + L1 essential story)
    |
    v
DecisionContext assembled (now includes episodicMemories + wakeUpContext)
    |
    v
[Generate Candidates]
    |-- per situation type candidate generator
    |-- typically 2-6 candidates per situation
    |
    v
CandidateAction[] generated
    |
    v
[Assess Risk] (for each candidate)
    |-- score 6 risk dimensions
    |-- compute overall risk tier
    |-- classify reversibility
    |-- estimate cost
    |
    v
[Predict Preference] (for each candidate)
    |-- query twin for relevant preferences
    |-- match against evidence
    |-- compute confidence level
    |
    v
[Rank Candidates]
    |-- primary: predicted user preference (highest confidence first)
    |-- secondary: risk (lower risk preferred when confidence is similar)
    |-- episodic boost: past episodes with positive feedback boost similar actions
    |-- tiebreaker: reversibility (prefer reversible)
    |
    v
[Select Best Candidate]
    |
    v
[Compute Confidence Score]
    |-- combine preference confidence, risk confidence, interpretation confidence
    |
    v
[Check Auto-Execute Threshold]
    |-- confidence rank >= MODERATE?
    |-- risk tier within trust tier allowance?
    |
    v
  /              \
YES               NO
  |                |
  v                v
[Policy Check]   [Create Escalation]
  |                |-- generate approval request
  |                |-- include explanation
  v                |-- route to user
ALLOW?             v
  |              DecisionOutcome
  |              { autoExecute: false,
  |                requiresApproval: true }
  v
  /       \
YES        NO
  |         |
  v         v
Execute   Escalate (policy-blocked)
  |
  v
DecisionOutcome
{ autoExecute: true }
```

## Examples for Each Situation Type

### Email Triage: Newsletter from Subscribed Source

```
Event: Email from "TechCrunch Daily" to user@example.com
Situation: email_triage, urgency: low, domain: email

Twin Profile:
  - Preference: "archive newsletters without reading" (CONFIRMED)
  - Evidence: 47 archived, 0 read, from this sender over 3 months
  - Spend norms: n/a

Candidates:
  1. archive_email (confidence: CONFIRMED, risk: negligible, reversible: true)
  2. label_email (confidence: MODERATE, risk: negligible, reversible: true)

Selected: archive_email
Auto-execute check:
  - Confidence rank (CONFIRMED) >= MODERATE? YES
  - Trust tier LOW_AUTONOMY allows risk <= LOW; action risk is NEGLIGIBLE? YES
Auto-execute: YES

Policy check: email domain allowed, trust tier LOW_AUTONOMY, no spend, reversible
Policy verdict: ALLOW

Outcome: Auto-archive. Log explanation: "Archived newsletter from TechCrunch Daily.
Based on: user has archived all 47 previous emails from this sender. Action is
reversible (can unarchive)."
```

### Calendar Conflict: Standup vs. Skip-Level

```
Event: Calendar overlap between "Team Standup" (recurring) and "1:1 with VP" (new)
Situation: calendar_conflict, urgency: high, domain: calendar

Twin Profile:
  - Preference: "prioritize skip-level over standup" (HIGH)
  - Evidence: rescheduled standup 3 times for similar conflicts
  - Preference: "15-minute buffer between meetings" (CONFIRMED)
  - Routines: standup is flexible, VP meetings are fixed

Candidates:
  1. accept_invite (confidence: HIGH, risk: negligible, reversible: true)
  2. decline_invite (confidence: LOW, risk: moderate, reversible: false)
  3. propose_alternative (confidence: LOW, risk: low, reversible: true)

Selected: accept_invite
Auto-execute check:
  - Confidence rank (HIGH) >= MODERATE? YES
  - Trust tier LOW_AUTONOMY allows risk <= LOW; action risk is NEGLIGIBLE? YES
Auto-execute: YES

Policy check: calendar domain allowed, trust tier LOW_AUTONOMY,
  no spend, reversible (can change RSVP)
Policy verdict: ALLOW

Outcome: Reschedule standup to next available slot with 15-min buffer.
Send automated note to standup organizer.
```

### Subscription Renewal: Price Increase

```
Event: Renewal notice for "CloudMusic Premium" at $14.99/month (was $12.99)
Situation: subscription_renewal, urgency: medium, domain: subscriptions

Twin Profile:
  - Preference: "renew music subscriptions" (HIGH)
  - Evidence: 12 consecutive renewals at $12.99
  - Spend norm: $15/month for music subscriptions
  - No evidence for how user handles price increases

Candidates:
  1. renew_subscription (confidence: HIGH, risk: moderate, reversible: false)
  2. cancel_subscription (confidence: LOW, risk: moderate, reversible: false)
  3. snooze_reminder (confidence: MODERATE, risk: negligible, reversible: true)

Selected: renew_subscription (highest score), but escalated
Auto-execute check:
  - Confidence rank (HIGH) >= MODERATE? YES
  - Trust tier LOW_AUTONOMY allows risk <= LOW; action risk is MODERATE? NO
Auto-execute: NO

Outcome: Escalate. "CloudMusic Premium renewal at $14.99/month (up from $12.99,
+15.4%). You've renewed 12 consecutive months. Usage: 340 hours last month.
The new price is within your music spend norm of $15/month but the increase is
new. Should I renew?"
```

### Grocery Reorder: Routine with One Substitution

```
Event: Reorder window open, previous order available
Situation: grocery_reorder, urgency: low, domain: shopping

Twin Profile:
  - Preference: "reorder weekly staples" (CONFIRMED)
  - Preference: "accept produce substitutions" (CONFIRMED)
  - Preference: "reject dairy substitutions" (CONFIRMED)
  - Spend norm: $120-$150 weekly groceries
  - Previous order: $135, one item unavailable (strawberries → blueberries)

Candidates:
  1. place_order (confidence: CONFIRMED, risk: low, reversible: true)
  2. add_to_list (confidence: HIGH, risk: negligible, reversible: true)

Selected: place_order
Auto-execute check:
  - Confidence rank (CONFIRMED) >= MODERATE? YES
  - Trust tier LOW_AUTONOMY allows risk <= LOW; action risk is LOW? YES
Auto-execute: YES

Policy check: shopping domain allowed, $135 within per-action and daily limits
Policy verdict: ALLOW

Outcome: Place order with blueberry substitution. Log: "Reordered weekly groceries
($135). Substituted strawberries with blueberries (produce substitution, per your
preference). Can modify before delivery cutoff at 6pm tomorrow."
```

### Travel: Flight Booking Above Norm

```
Event: Flight options for Denver trip in 3 weeks
Situation: travel_decision, urgency: medium, domain: travel

Twin Profile:
  - Preference: "aisle seat" (CONFIRMED)
  - Preference: "United Airlines" (HIGH)
  - Preference: "morning departures" (HIGH)
  - Preference: "avoid connections under 90 min" (CONFIRMED)
  - Spend norm: $400 for domestic flights

Best match: United, aisle, morning, direct, $450

Candidates:
  1. book_travel (confidence: HIGH, risk: high (financial), reversible: false)
  2. save_option (confidence: HIGH, risk: negligible, reversible: true)

Selected: book_travel (highest score), but escalated
Auto-execute check:
  - Confidence rank (HIGH) >= MODERATE? YES
  - Trust tier LOW_AUTONOMY allows risk <= LOW; action risk is HIGH? NO
Auto-execute: NO

Outcome: Escalate. "Found flights for Denver. Best match for your preferences:
United 1234, morning departure, direct, aisle seat at $450 (12% above your usual
$400 norm). Alternative: Frontier 567, morning, direct, middle seat at $280.
Alternative: United 1235, afternoon departure, direct, aisle at $385.
Which would you prefer?"
```

## Edge Cases and How They're Handled

### Contradictory Preferences

**Situation:** Twin has evidence that the user likes morning flights (5 bookings) but also has a recent explicit statement "I'm switching to afternoon flights."

**Handling:** Explicit statements override behavioral inference. The twin model updates the preference, but retains the historical evidence. If the user then books a morning flight, both pieces of evidence exist and the confidence level drops to `LOW` until a clear pattern re-emerges. In the meantime, the engine escalates.

### No Twin Profile Exists

**Situation:** New user, no preferences learned yet.

**Handling:** All candidates receive `SPECULATIVE` confidence for predicted preference. All decisions escalate. The system presents options with its reasoning framework visible: "I don't have enough data to act here. Here's what I see and what I'd consider. What would you like me to do?" Each response becomes initial evidence.

### Multiple Actions Needed

**Situation:** A calendar conflict requires both rescheduling one meeting and notifying attendees.

**Handling:** The engine generates a compound candidate with multiple sub-actions. Each sub-action is risk-assessed independently. The overall risk is the maximum across sub-actions. All sub-actions execute together or not at all (transactional semantics where possible).

### Rapidly Changing Context

**Situation:** An email arrives, the engine starts processing, and before it finishes, another email from the same sender arrives with "Never mind, ignore my last email."

**Handling:** Events are processed in order. The second email creates a new decision that may override or cancel the first. If the first action has already executed, the second event may trigger an undo. If the first action hasn't executed, it's superseded. The engine checks for superseding events before executing.

### Confidence Exactly at Threshold

**Situation:** Confidence is 0.70, threshold is 0.70.

**Handling:** At-threshold is treated as meeting the threshold (>=, not >). The threshold represents "this is the minimum confidence at which we're willing to act." If the engineering team decides this is too aggressive, the threshold can be raised. The boundary condition is explicit and testable.

### Domain Not Yet Seen

**Situation:** An event arrives from a domain the user has never interacted with through SkyTwin.

**Handling:** Treated as a new domain. System requires explicit approval for the first N actions (default: 10) regardless of trust tier. After N approved actions, normal trust tier rules apply. The user can also pre-approve a domain in their settings.

### IronClaw Execution Fails

**Situation:** The engine decided to auto-execute, but IronClaw returns a failure.

**Handling:** Record the failure in the execution result. Notify the user that an automated action was attempted but failed. Include the explanation of what was intended and why. Do not automatically retry unless the failure is classified as transient by the IronClaw adapter. If the action was time-sensitive, escalate to the user with urgency.

### User Corrects a Decision During Processing

**Situation:** The engine is processing an event and the user simultaneously submits a preference change that affects the decision.

**Handling:** CockroachDB serializable transactions prevent read-write conflicts. The decision either uses the old preference (if the transaction started first) or the new one (if the preference update committed first). In either case, the decision is consistent. If the user's correction is processed after the action executes, it becomes feedback for the next decision.

### Quiet Hours

**Situation:** An event arrives during the user's configured quiet hours.

**Handling:** Non-urgent decisions are queued until quiet hours end. Urgent decisions (urgency: `critical`) still process but escalation notifications are suppressed unless the urgency is truly time-critical. The system does not auto-execute during quiet hours even for actions it would normally handle autonomously. This is a safety valve: the user has explicitly said "don't bother me during these hours."
