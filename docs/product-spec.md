# SkyTwin Product Specification

## Vision

Most personal assistants are stuck in the wrong loop:

1. Wait for a prompt
2. Ask a follow-up question
3. Do one thing
4. Forget everything
5. Interrupt you again later

This is the "amnesiac waiter" model of personal automation. Every interaction starts from scratch. The system has no opinion, no memory of your preferences, no sense of what you'd probably want. It treats you as a stranger every time.

SkyTwin exists because we believe there's a better loop:

1. Ingest signals from connected accounts and user behavior
2. Maintain a structured digital twin of preferences, tolerances, and decision patterns
3. Interpret incoming situations as decision opportunities
4. Infer what the user would likely want, using the twin as a proxy
5. Classify risk, reversibility, and sensitivity
6. Execute safe actions through IronClaw -- or escalate with context when confidence is low
7. Explain every action taken
8. Learn from feedback, reversals, edits, and outcomes

The thesis: **if you build a real model of what someone wants, you can act on their behalf in bounded domains without constantly pestering them.** Not for everything. Not without guardrails. But for the 80% of operational decisions where the right answer is knowable and the downside is manageable.

SkyTwin is a delegated judgment layer. It sits above IronClaw (the execution runtime) and below the user (who remains sovereign). Its job is to answer the question: "What would the user want here, and is it safe to just do it?"

## Target User

SkyTwin is for the person who wants **bounded operational autonomy**.

They are:
- Busy enough that routine decisions feel like overhead
- Organized enough to have preferences worth modeling
- Trust-inclined but not reckless -- they want automation that earns its latitude
- Willing to invest upfront in teaching the system, in exchange for declining interruptions over time
- Comfortable with a system that acts on their behalf in low-stakes domains
- Unwilling to hand over the keys entirely

They are not:
- Someone who wants to micromanage every action (use a to-do app)
- Someone who wants fully autonomous AI with no constraints (build your own thing, and good luck)
- Someone looking for a chatbot to talk to (SkyTwin is operational, not conversational)

The ideal user thinks: "I've told you three times that I prefer aisle seats. Just book the aisle seat."

## Core Loop

```
Signal Arrives
    |
    v
[Signal Ingestion] -- normalize event, attach metadata
    |
    v
[Situation Interpreter] -- classify as decision opportunity
    |
    v
[Twin Model Lookup] -- retrieve preferences, inferences, history
    |
    v
[Decision Engine] -- generate candidates, assess risk, select action
    |
    v
[Policy Engine] -- enforce constraints, spend limits, trust tiers
    |
    v
  /              \
auto-execute      escalate
  |                  |
  v                  v
[IronClaw]      [Approval Request]
  |                  |
  v                  v
[Explanation]    [User Responds]
  |                  |
  v                  v
[Feedback Loop] <----+
    |
    v
[Twin Model Update]
```

Every path through this loop produces an explanation record. Every outcome feeds back into the twin model. The system gets better at predicting what you want and more calibrated about when to act autonomously.

## System Modules

### 1. Identity and User Context

Owns user identity, autonomy settings, trust tier, connected accounts, and permission scopes. This is the "who" layer -- it knows what accounts are connected, what domains are active, what spend limits are configured, and what the user's current trust tier allows.

**Responsibilities:**
- User CRUD and authentication context
- Autonomy settings management (spend caps, domain allow/block lists, quiet hours)
- Trust tier tracking and progression
- Connected account registry
- Permission scope management

### 2. Signal Ingestion

Normalizes incoming events from connected accounts into a standard internal format. Handles email, calendar, tasks, subscriptions, purchases, and behavioral signals. In MVP, most connectors are mocked, but the interfaces are clean enough that real integrations slot in without architectural changes.

**Responsibilities:**
- Event normalization across domains
- Connector abstraction (email, calendar, subscriptions, etc.)
- Event deduplication and ordering
- Metadata extraction and enrichment
- Raw event persistence for replay

### 3. Twin Model

The core differentiator. Maintains a structured digital twin representing the user's preferences, inferred patterns, risk tolerance, spend norms, communication style, routines, and domain-specific heuristics.

The twin is not a bag of keywords or a vector embedding. It is a typed, versioned, inspectable data structure with provenance tracking. Every preference has a confidence level, supporting evidence, and a timestamp. Inferences are distinguished from explicit statements. Contradictory evidence is tracked, not hidden.

**Responsibilities:**
- Twin profile CRUD with versioning
- Preference management (explicit and inferred)
- Confidence scoring and recency weighting
- Evidence accumulation and contradiction tracking
- Profile snapshot and historical reconstruction
- Domain-specific heuristic storage

### 4. Situation Interpreter

Transforms raw events into typed `DecisionObject` instances. This is where "you got an email" becomes "you have a low-priority newsletter that matches your archive-without-reading pattern" or "you have a calendar conflict between two meetings you've both attended before."

**Responsibilities:**
- Event classification by situation type
- Urgency assessment
- Domain identification
- Context enrichment from recent history
- Structured output as `DecisionObject`

### 5. Decision Engine

The judgment core. Given a situation, the twin profile, applicable policies, and the user's trust tier, the decision engine generates candidate actions, assesses risk for each, predicts user preference using the twin, and selects the best action -- or determines that escalation is needed.

**Responsibilities:**
- Candidate action generation per situation type
- Risk assessment across six dimensions
- Twin-informed preference prediction
- Confidence calculation
- Auto-execute vs. escalate determination
- Decision outcome recording

### 6. Safety / Policy Engine

The guardrail layer. Evaluates every candidate action against domain policies, spend limits, trust tier constraints, reversibility requirements, and sensitivity checks. The policy engine has veto power: if a policy says no, the action does not execute, regardless of what the twin predicts.

**Responsibilities:**
- Policy rule evaluation
- Spend limit enforcement (per-action and daily)
- Trust tier gating
- Irreversible action detection
- Privacy, legal, financial, and social sensitivity checks
- Approval routing
- Domain allow/block list enforcement
- Default-safe behavior (when in doubt, escalate)

### 7. IronClaw Adapter

The execution boundary. SkyTwin decides; IronClaw executes. The adapter converts approved actions into IronClaw execution plans, sends them downstream, and handles execution results (including failures and rollback requests).

The adapter uses an interface pattern so the real IronClaw API can be swapped in when it stabilizes. In development, a mock adapter simulates execution with configurable delays and failure rates.

**Responsibilities:**
- Action-to-execution-plan conversion
- Downstream API communication
- Execution result normalization
- Failure handling and retry coordination
- Rollback request forwarding
- Mock implementation for development

### 8. Explanation / Audit Layer

Every meaningful action produces an explanation record. This is not optional logging -- it is a first-class system requirement. If SkyTwin can't explain why it did something, it shouldn't have done it.

**Responsibilities:**
- Explanation record generation for every action
- Human-readable summary production
- Evidence citation (which preferences, which signals)
- Alternative action documentation (why X over Y)
- Correction guidance (how to adjust future behavior)
- Audit trail persistence in CockroachDB

### 9. Feedback Learning

Closes the loop. When the user approves, rejects, edits, or undoes an action -- or explicitly restates a preference -- the feedback learning layer updates the twin model in a principled way. Approvals strengthen existing inferences. Rejections weaken them or create counter-evidence. Edits refine preferences. Explicit statements override inferences.

**Responsibilities:**
- Feedback event ingestion
- Twin model update calculation
- Confidence adjustment
- Evidence creation from feedback
- Preference refinement
- Trust tier progression evaluation
- Historical feedback persistence

### 10. Evaluation Harness

Measures whether the system is actually working. Supports scenario simulation, replay tests, dangerous-case regression suites, and calibration checks. The eval harness answers the questions that matter: Did it make the right call? Did it overstep? Did it escalate when needed? Did it improve after correction?

**Responsibilities:**
- Scenario definition and execution
- Decision replay from historical data
- Metric calculation (interruption rate, false autonomy rate, etc.)
- Regression test management
- Calibration analysis
- Report generation

## Example Workflows

### Email Triage

**Signal:** New email arrives from a known sender.

**Situation:** The situation interpreter classifies it based on sender, subject, content signals. Possible classifications: personal-important, work-urgent, newsletter, transactional-receipt, spam-adjacent, requires-reply.

**Twin consultation:** The twin knows this user archives all newsletters without reading, replies to their manager within 2 hours, and ignores transactional receipts from known vendors.

**Candidate actions:**
- Archive without notification (newsletter from subscribed source)
- Surface with summary (work email from known colleague)
- Draft reply using communication style preferences (routine request from manager)
- Send pre-approved routine reply (meeting confirmation)
- Escalate with context (unknown sender, ambiguous content)

**Policy check:** Sending any email reply requires at least `LOW_AUTONOMY` trust tier. Drafting is allowed at `SUGGEST`. Archiving newsletters is allowed at `LOW_AUTONOMY` if the user has archived from this sender before.

**Outcome:** For a known newsletter, auto-archive and log explanation. For a routine manager request, draft a reply and surface it for approval. For an unknown sender, escalate with a one-line summary.

### Calendar Conflict

**Signal:** Two calendar events overlap.

**Situation:** Calendar conflict detected. One is a recurring team standup, the other is a newly added 1:1 with a skip-level manager.

**Twin consultation:** The twin knows the user prioritizes skip-level meetings over standups, prefers to reschedule standups rather than decline them, and wants at least a 15-minute buffer between back-to-back meetings.

**Candidate actions:**
- Reschedule standup to next available slot that preserves buffer
- Decline standup with auto-generated note
- Escalate with both options presented

**Policy check:** Calendar modifications are allowed at `LOW_AUTONOMY` for recurring meetings the user has rescheduled before. Declining meetings requires `MODERATE_AUTONOMY`.

**Outcome:** Reschedule the standup, send a brief note to the organizer, log explanation.

### Subscription Renewal

**Signal:** Renewal notice for a streaming service at $15.99/month.

**Situation:** Subscription renewal approaching. Service has been used 3 times in the past month. Price is within historical norms.

**Twin consultation:** The twin shows the user has renewed this service for 18 consecutive months, has a spend norm of $20/month for streaming, and has never expressed interest in canceling.

**Candidate actions:**
- Auto-renew (within spend norms, long history of renewal)
- Snooze notification (low urgency)
- Escalate with usage summary

**Policy check:** $15.99 is within per-action spend limit. Subscription renewal is in an allowed domain. Action is reversible (can cancel within billing period).

**Outcome:** Auto-renew, log explanation including usage stats and cost history.

### Grocery Reorder

**Signal:** Recurring grocery delivery window approaching. Previous order available for repeat.

**Situation:** Reorder opportunity. Last order was 10 days ago. User typically orders every 7-10 days.

**Twin consultation:** The twin knows the user's staple items, brand preferences (prefers store-brand for basics, name-brand for coffee), substitution tolerance (accepts substitutions for produce, rejects for dairy), and weekly grocery budget norm ($120-$150).

**Candidate actions:**
- Reorder last order with known substitution rules applied
- Reorder with price-check (flag items that increased > 10%)
- Escalate with order summary for review

**Policy check:** Total order estimate $135 is within daily spend limit and grocery domain limit. Substitution rules are within policy. Action is partially reversible (can modify before delivery cutoff).

**Outcome:** Place repeat order with substitution rules, flag the one item that increased 15% in price for user awareness. Log explanation.

### Travel Decision

**Signal:** Flight options available for an upcoming trip.

**Situation:** User has a trip to Denver in 3 weeks. Multiple flight options available.

**Twin consultation:** The twin knows the user prefers aisle seats, flies United when possible, avoids connections under 90 minutes, has a travel spend norm of $400 for domestic flights, and prefers morning departures.

**Candidate actions:**
- Book best-match flight (United, aisle, morning, $380, direct)
- Present top 3 options ranked by twin preference match
- Escalate (trip cost exceeds norms or no good options)

**Policy check:** $380 is within per-action spend limit for travel domain. Flight booking is irreversible after 24-hour window but has airline cancellation policy. Trust tier must be `MODERATE_AUTONOMY` or higher for travel purchases.

**Outcome:** At `MODERATE_AUTONOMY`, book the best-match flight. At `LOW_AUTONOMY`, present ranked options for approval. Either way, log explanation with preference-match breakdown.

## Operating Principles

### 1. Ask the Twin Before Asking the User

The system should consult its model of user preferences before interrupting the user. If the twin can answer the question with high confidence, the user shouldn't need to see it. This doesn't mean the system acts without safeguards -- it means the system tries to predict the right answer before asking.

The goal is not to avoid all user interaction. It is to avoid *unnecessary* user interaction. When the system does escalate, it should do so with enough context that the user can decide quickly.

### 2. Autonomy Expands with Trust

A new user starts with minimal autonomy. The system suggests actions and waits for approval. As the user provides feedback -- approvals, rejections, edits -- the system builds confidence and earns broader latitude.

Trust is not granted globally. A user might trust SkyTwin with email triage but not with calendar management. Trust is domain-specific, evidence-based, and revocable. Repeated correct decisions in a domain earn more autonomy in that domain. A significant mistake can reduce trust.

### 3. The User Remains Sovereign

The user can, at any time:
- Inspect what the system has learned about them
- Override any decision
- Narrow autonomy in any domain
- Revoke trust entirely
- Delete learned preferences
- Sandbox the system to observation-only mode

SkyTwin is a delegate, not a replacement. Sovereignty is non-negotiable.

### 4. Reversibility Matters

Reversible actions can be automated more aggressively. Archiving an email is reversible. Sending a reply is not. Renewing a subscription with a cancellation window is partially reversible. Booking a non-refundable flight is irreversible.

The system must accurately classify reversibility and adjust its confidence thresholds accordingly. Irreversible actions require higher confidence, higher trust tiers, and more explicit policy authorization. Lying about reversibility -- treating an irreversible action as reversible to avoid escalation -- is a system bug, not an edge case.

### 5. Explanation Is Mandatory

Every action the system takes must produce an explanation that a reasonable person can understand. The explanation must include: what happened, what evidence was used, which preferences were invoked, why this action was chosen over alternatives, and how the user can correct future behavior if the action was wrong.

Explanations are not debugging artifacts. They are a product feature. If the system can't explain why it did something, it shouldn't have done it.

### 6. The System Should Earn Silence

Success is measured by declining interruption rate. A well-tuned SkyTwin instance should, over time, need to ask the user less. Not because it's suppressing important decisions, but because it's getting better at handling routine ones.

"Earning silence" means the system demonstrates, through a track record of correct autonomous actions, that it doesn't need to ask. If the system is asking as often in month 6 as it was in month 1, something is wrong -- either with the twin model, the confidence thresholds, or the feedback loop.

### 7. Memory Must Be Durable, Inspectable, and Evolvable

SkyTwin's memory -- the twin profile, decision history, feedback records, policy state -- lives in CockroachDB as structured, versioned, queryable data. Not as a mystery blob. Not as ephemeral state that vanishes when a process restarts.

Memory must be:
- **Durable:** Survive crashes, deployments, and infrastructure changes
- **Inspectable:** The user can see what the system knows about them and how it learned it
- **Evolvable:** The schema can grow to support richer memory capabilities without requiring a ground-up rewrite

This rules out treating memory as purely an embedding store or a prompt-stuffing exercise. Structured data with provenance first; embeddings as a supplementary capability later.

## What SkyTwin Is NOT

**Not a chatbot.** SkyTwin is not optimized for conversation. It is optimized for operational judgment. You don't chat with it; you configure it, review its decisions, and provide feedback. The interaction surface is a dashboard and notification stream, not a chat window.

**Not an unconstrained autonomous agent.** SkyTwin does not pursue open-ended goals. It does not "figure out what to do" from first principles. It operates within explicitly defined domains, under user-configured policies, with hard limits on spend, risk, and action types. The constraint system is not a limitation to work around -- it is the product.

**Not a Zapier clone.** Zapier executes deterministic rules: "if X, then Y." SkyTwin exercises judgment: "given what I know about this user, X probably means they'd want Y, and the risk is low enough to act." The difference is inference, confidence, and learning.

**Not AGI theater.** SkyTwin does not pretend to be generally intelligent. It does not have opinions about philosophy. It does not roleplay as a person. It is a preference-modeling and decision-delegation system with explicit scope boundaries. The tagline is "Mildly Apocalyptic Personal Automation," not "Artificial General Intelligence." The emphasis is on "mildly."

## Success Metrics

### Fewer Interruptions
- **Interruption rate:** Percentage of decisions that require user input. Should decline over time as the twin model improves.
- **Target:** New users start near 90% escalation. After 3 months of active use, target is < 30% escalation for routine domains.

### Correct Autonomy
- **False autonomy rate:** Percentage of auto-executed actions that the user would have done differently. Measured via post-hoc review and explicit corrections.
- **Target:** < 5% false autonomy rate for established users in trusted domains.

### No Overreach
- **Policy violation rate:** Actions that exceeded the user's configured constraints. Must be zero. Not "low" -- zero. Policy violations are bugs.
- **Escalation correctness:** When the system escalates, was escalation warranted? Over-escalation is annoying; under-escalation is dangerous. Both are tracked.

### Learning from Feedback
- **Feedback incorporation rate:** Percentage of user corrections that produce measurable changes in future behavior.
- **Calibration score:** Does the system's confidence match its accuracy? A system that says "I'm 90% sure" should be right 90% of the time.
- **Convergence:** Does the twin model stabilize over time for stable preferences, while adapting to genuine changes?

### Explanation Quality
- **Explanation completeness:** Does every auto-executed action have a corresponding explanation record?
- **Explanation usefulness:** Can a user reading the explanation understand why the system acted and how to correct it? (Measured via eval scenarios and user review.)

### Operational Health
- **Decision latency:** Time from event arrival to action execution or escalation. Target: < 5 seconds for routine decisions.
- **System reliability:** Uptime, error rate, data durability. Standard operational metrics.
- **Twin model freshness:** Time between last feedback and twin model update. Should be near-real-time.
