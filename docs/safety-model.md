# SkyTwin Safety Model

## Safety Philosophy

SkyTwin is a system that acts on behalf of a human. This is inherently dangerous if done poorly. The safety model is not an afterthought or a compliance checkbox -- it is the reason SkyTwin can exist at all. Without robust safety, "delegated judgment" is just "autonomous agent with a nicer name."

Our safety philosophy: **delegated operational judgment under user-owned constraints.**

This means:
- The user defines the boundaries. The system operates within them.
- The system defaults to caution when uncertain.
- Every constraint is enforced mechanically, not by hoping the AI model "does the right thing."
- The system can be inspected, overridden, narrowed, and shut off at any time.
- Safety failures are bugs, not edge cases.

We are not building a system that is "safe enough" -- we are building a system where the safety constraints are the product.

## Threat Model

What can go wrong when a system acts on your behalf? Here are the threats we design against:

### 1. Overreach

The system does something the user didn't want and wouldn't have approved.

**Examples:**
- Sending an email reply with the wrong tone
- Canceling a subscription the user actually wants
- Rescheduling a meeting the user considers important
- Making a purchase the user wouldn't have made

**Why it matters:** Overreach erodes trust. A single bad autonomous action can undo months of correctly handled decisions. Users will disable the system entirely if they can't trust its boundaries.

### 2. Financial Harm

The system spends money the user didn't authorize or wouldn't have spent.

**Examples:**
- Renewing an expensive subscription without checking price changes
- Booking a flight at a price above the user's tolerance
- Ordering groceries with unexpected price increases
- Accumulating many small charges that individually look fine but total too much

**Why it matters:** Money is irreversible. You can unarchive an email. You usually can't unspend money.

### 3. Privacy Violations

The system exposes private information or accesses data it shouldn't.

**Examples:**
- Forwarding a personal email to a work context
- Including sensitive calendar details in an automated message
- Logging private information in explanation records visible to support staff
- Sharing purchase history across accounts

**Why it matters:** Privacy violations can't be undone. Once information is exposed, it's exposed.

### 4. Social Damage

The system says something to someone that damages a relationship.

**Examples:**
- Sending a reply with an inappropriate tone to a sensitive contact
- Declining a meeting invitation in a way that offends the organizer
- Auto-responding to a personal message with corporate-sounding language
- Acting on a misunderstood social context

**Why it matters:** Social damage is irreversible and context-dependent. The system is bad at social nuance (all systems are), so it must be especially cautious here.

### 5. Legal Exposure

The system takes an action with legal consequences the user didn't anticipate.

**Examples:**
- Agreeing to terms of service on the user's behalf
- Making a purchase that creates a binding contract
- Sending a communication that could be construed as a legal commitment
- Handling data in a way that violates regulatory requirements

**Why it matters:** Legal consequences can be severe, long-lasting, and expensive to unwind.

## Defense Layers

Safety is not a single check. It is a series of overlapping defenses, each of which can independently prevent a bad outcome. If one layer fails, the others still protect the user.

### Layer 1: Trust Tiers

Every user has a trust tier that gates what the system can do autonomously. New users start at `OBSERVER` (no autonomy). Trust is earned through demonstrated correct decisions and consistent feedback.

See [Trust Tier Progression](#trust-tier-progression) below.

### Layer 2: Policy Engine

Every candidate action is evaluated against the user's active policies before execution. Policies are explicit, inspectable rules that the user can configure. The policy engine has veto power.

See [Policy Rules](#policy-rules) below.

### Layer 3: Spend Limits

Hard caps on financial exposure:
- **Per-action limit:** No single action can exceed this amount. Configurable per user.
- **Daily limit:** Total autonomous spending in a 24-hour window. Configurable per user.
- **Domain limits:** Per-domain spend caps (e.g., $50/day for groceries, $500/month for subscriptions).

Spend limits are enforced mechanically. "The estimated cost is $49.99 and the limit is $50.00" passes. "$50.01" fails. No rounding, no approximation, no "close enough."

### Layer 4: Reversibility Classification

Every action is classified as reversible, partially reversible, or irreversible. This classification directly affects the confidence threshold required for auto-execution:

| Reversibility | Confidence Required | Trust Tier Required |
|--------------|-------------------|-------------------|
| Reversible | Moderate | LOW_AUTONOMY |
| Partially reversible | High | MODERATE_AUTONOMY |
| Irreversible | Very high | HIGH_AUTONOMY (or always escalate) |

Reversibility is assessed per action type and recorded in the `CandidateAction`. Misclassifying reversibility is a safety bug.

### Layer 5: Domain Controls

Users can enable or disable autonomous action per domain:
- **Allowed domains:** Domains where the system can act according to trust tier
- **Blocked domains:** Domains where the system must always escalate
- **Domain-specific policies:** Custom rules per domain (e.g., "never auto-reply to external emails")

Domain controls are additive to trust tier -- a domain must be both allowed AND within the trust tier's authorization.

### Layer 6: Approval Routing

When the system determines it cannot auto-execute (due to risk, confidence, policy, or trust tier), it creates an approval request. Approval requests include:
- What the system wants to do
- Why it thinks this is the right action
- What evidence supports this choice
- What the risk assessment looks like
- Alternatives it considered
- Urgency classification

The user can approve, reject, edit, or let the request expire.

## Trust Tier Progression

Trust is earned, not assumed. Progression is domain-specific: high trust in email triage doesn't grant high trust in financial decisions.

### Tier Definitions

**OBSERVER** (Initial state)
- System observes events and records what it *would have* done
- No autonomous action of any kind
- Purpose: Build initial twin model from observation and explicit preferences
- Duration: Until user explicitly promotes or provides sufficient feedback

**SUGGEST**
- System generates candidate actions and presents them to the user
- All actions require explicit approval
- Purpose: Let the user see the system's judgment and correct it
- Promotion criteria: Consistent approval rate > 80% over 20+ suggestions in a domain

**LOW_AUTONOMY**
- System can auto-execute low-risk, reversible actions in allowed domains
- Moderate-risk and irreversible actions still require approval
- Purpose: Handle routine, low-stakes operations autonomously
- Promotion criteria: < 5% correction rate over 50+ auto-executed actions in a domain

**MODERATE_AUTONOMY**
- System can auto-execute moderate-risk actions in allowed domains
- High-risk and irreversible actions still require approval (unless explicitly allowed)
- Purpose: Handle most operational decisions with occasional escalation
- Promotion criteria: < 3% correction rate over 100+ auto-executed actions, including moderate-risk

**HIGH_AUTONOMY**
- System can auto-execute most actions except critical-risk
- Irreversible actions may auto-execute if explicitly allowed by domain policy
- Purpose: Near-full operational delegation in trusted domains
- Promotion criteria: Sustained < 2% correction rate over 200+ actions, no safety-relevant errors

### Trust Demotion

Trust can decrease. Triggers:
- User manually reduces trust tier (immediate, always honored)
- Multiple rejected auto-executed actions in a short window (automatic demotion review)
- A single safety-relevant error (automatic demotion by one tier)
- User undoes an irreversible action (if possible -- flags for review)
- Extended period of inactivity (trust doesn't persist indefinitely without reinforcement)

Demotion is biased toward safety: it's easier to lose trust than to gain it.

## Risk Dimensions

Every `CandidateAction` includes a `RiskAssessment` with scores across six dimensions:

### 1. Reversibility

Can this action be undone?

| Rating | Meaning | Examples |
|--------|---------|---------|
| Negligible | Trivially reversible | Archive email, snooze notification |
| Low | Easily reversible with minor effort | Reschedule recurring meeting |
| Moderate | Reversible but requires action | Cancel subscription before billing |
| High | Difficult to fully reverse | Send email reply, place order |
| Critical | Effectively irreversible | Delete data, send to large audience |

### 2. Financial Impact

How much money is at stake?

| Rating | Meaning | Examples |
|--------|---------|---------|
| Negligible | $0 | Archive, reschedule |
| Low | < $10 | Small subscription renewal |
| Moderate | $10-$100 | Grocery order, service renewal |
| High | $100-$1000 | Flight booking, major purchase |
| Critical | > $1000 | Large purchases, financial commitments |

### 3. Legal Sensitivity

Does this action have legal implications?

| Rating | Meaning | Examples |
|--------|---------|---------|
| Negligible | No legal implications | Routine email management |
| Low | Minimal legal surface | Standard subscription agreement |
| Moderate | Some legal consideration | Service agreement with terms |
| High | Meaningful legal implications | Contract-like commitments |
| Critical | Significant legal exposure | Binding agreements, regulatory actions |

### 4. Privacy Sensitivity

Does this action involve private or sensitive information?

| Rating | Meaning | Examples |
|--------|---------|---------|
| Negligible | No private data involved | Archive newsletter |
| Low | Routine personal data | Calendar management |
| Moderate | Sensitive personal data | Email with personal content |
| High | Highly sensitive data | Financial records, health info |
| Critical | Data that must never be auto-shared | Legal documents, credentials |

### 5. Relationship Sensitivity

Could this action affect a relationship if done wrong?

| Rating | Meaning | Examples |
|--------|---------|---------|
| Negligible | No interpersonal impact | Archive, organize |
| Low | Routine professional interaction | Accept meeting, send receipt |
| Moderate | Interaction with known contacts | Reply to colleague email |
| High | Sensitive interpersonal context | Decline invitation, respond to complaint |
| Critical | Relationship-defining moment | Reply to boss, respond during conflict |

### 6. Operational Risk

Could this action disrupt the user's work or systems?

| Rating | Meaning | Examples |
|--------|---------|---------|
| Negligible | No operational impact | Read-only actions |
| Low | Minor operational impact | Reschedule non-critical meeting |
| Moderate | Some operational disruption | Change recurring schedule |
| High | Significant disruption possible | Cancel service, modify workflow |
| Critical | Could cause major disruption | Actions affecting production systems |

## Default-Safe Behaviors

When the system is uncertain, it defaults to safety:

1. **Unknown situation type:** Escalate with raw event summary. Never guess.
2. **Missing twin profile:** Treat as OBSERVER tier. Escalate everything.
3. **Policy evaluation error:** Deny the action. Log the error. Do not fail open.
4. **Confidence below threshold:** Escalate with context. Include what the system thinks and why it's not sure.
5. **Multiple contradictory preferences:** Escalate and explain the contradiction.
6. **New domain with no history:** Require explicit approval for first N actions (configurable, default 10).
7. **Spend limit query failure:** Assume limit is exhausted. Deny spend-related actions.
8. **IronClaw unavailable:** Queue the action, notify the user, do not retry silently.
9. **Reversibility uncertain:** Classify as irreversible. Better to over-escalate than to misclassify.

## Escalation Rules

Escalation happens when the system determines it should not auto-execute. The escalation is not a failure -- it is the system working correctly.

### Must Always Escalate

- Actions classified as `CRITICAL` risk in any dimension
- Actions where the user has explicitly required approval (via domain policy)
- Actions in blocked domains
- Actions that exceed spend limits
- First-ever action in a new domain (unless user has pre-approved the domain)
- Actions where contradictory preferences exist and confidence is split

### Should Escalate (Configurable)

- Actions where overall confidence is below the auto-execute threshold
- Actions where the twin has weak or speculative evidence
- Actions that don't match any known preference pattern
- Actions where the cost is within 10% of the spend limit
- Actions during quiet hours

### Escalation Format

Every escalation includes:
1. **What:** One-sentence description of the proposed action
2. **Why:** Evidence from the twin profile supporting this action
3. **Risk:** Summary risk assessment
4. **Alternatives:** Other actions considered and why they were ranked lower
5. **Ask:** Clear question ("Should I proceed?" / "Which option?" / "Need more context")
6. **Urgency:** How time-sensitive is this decision

## Approval Routing Logic

When an action requires approval:

1. **Check urgency:** Is this time-sensitive?
   - Immediate: Notify via highest-priority channel (push notification)
   - Soon: Standard notification
   - Normal: Add to review queue
   - Low: Batch with other pending approvals

2. **Set expiry:** Approval requests have a TTL based on urgency:
   - Immediate: 1 hour
   - Soon: 4 hours
   - Normal: 24 hours
   - Low: 72 hours

3. **On expiry:** Default behavior depends on action type:
   - Reversible actions: May auto-execute if confidence is high and urgency is pressing
   - Irreversible actions: Never auto-execute on expiry. Notify user of missed window.

4. **On approval:** Execute the action via IronClaw. Record approval as positive feedback.

5. **On rejection:** Cancel the action. Record rejection as negative feedback. Include user's reason if provided.

6. **On edit:** Execute the modified action. Record the edit as refinement feedback (twin model learns the delta).

## Audit and Transparency Requirements

### What Must Be Logged

Every decision in the pipeline produces an audit trail:

1. **Raw event:** The original signal that triggered the decision
2. **Interpreted situation:** How the system classified the event
3. **Twin profile snapshot:** The twin state at decision time (version reference, not full copy)
4. **Candidate actions:** All actions considered, with risk assessments
5. **Selected action:** What was chosen and why
6. **Policy evaluation:** Which policies were checked and what they returned
7. **Outcome:** Whether it was auto-executed or escalated
8. **Execution result:** If executed, what happened (success, failure, partial)
9. **User response:** If escalated, what the user decided
10. **Feedback effect:** How the outcome affected the twin model

### What the User Can See

The user can inspect:
- Current twin profile (all preferences and inferences, with evidence)
- Decision history (every decision, its outcome, and explanation)
- Policy configuration (all active policies and their effects)
- Approval history (past approval requests and responses)
- Trust tier status (current tier, progression metrics, demotion history)
- Feedback impact (how their corrections changed the twin)

### Retention

- Decision history: Retained indefinitely (needed for evals and audit)
- Twin profile versions: Retained indefinitely (needed for historical reconstruction)
- Raw events: Retained for 90 days, then summarized (configurable)
- Explanation records: Retained indefinitely
- Feedback events: Retained indefinitely

## Rollback Capabilities

### What Can Be Rolled Back

1. **Twin model changes:** Revert to any previous twin profile version
2. **Policy changes:** Revert policy configurations
3. **Trust tier changes:** Manual trust tier adjustment (user-initiated)
4. **Executed actions (where possible):** Request rollback via IronClaw for reversible actions

### What Cannot Be Rolled Back

1. **Sent communications:** Cannot unsend emails or messages
2. **Financial transactions (usually):** Refunds may be possible but aren't guaranteed
3. **Expired time-sensitive opportunities:** If a deadline passed while the system waited for approval
4. **Information disclosure:** Once information is shared, it's shared

### Rollback Process

1. User requests undo for a specific decision
2. System checks reversibility classification
3. If reversible: send rollback request to IronClaw, record undo as feedback
4. If partially reversible: present user with what can and cannot be undone
5. If irreversible: notify user that rollback is not possible, record as feedback for future avoidance

## What the System Must NEVER Do Without Explicit Approval

Regardless of trust tier, confidence, or twin prediction, these actions always require explicit user approval:

1. **Delete data permanently** -- Any action that destroys information without recovery
2. **Send to a large audience** -- Communications to groups larger than a configurable threshold (default: 10 recipients)
3. **Accept legal agreements** -- Terms of service, contracts, binding commitments
4. **Share credentials or secrets** -- Passwords, API keys, access tokens
5. **Modify security settings** -- Account passwords, 2FA, access permissions
6. **Actions above spend threshold** -- Even for HIGH_AUTONOMY users, there is an absolute ceiling (configurable, default: $500)
7. **Cross-context actions** -- Moving data between personal and professional contexts
8. **Actions involving minors** -- Any action related to accounts or communications involving children
9. **Health or medical decisions** -- Scheduling, canceling, or modifying medical appointments or prescriptions
10. **Emergency services** -- Never auto-contact emergency services or make safety-critical decisions

These are hardcoded safety invariants, not configurable policies. They exist to protect against catastrophic edge cases, even in a system that is otherwise well-calibrated.

## Failure Modes and Mitigations

### Failure: Twin model is wrong about a preference

**Symptom:** System auto-executes an action the user disagrees with.
**Mitigation:** User rejects or undoes the action. Twin model updates. Confidence decreases. Trust tier may be reviewed. Explanation record documents what went wrong.
**Design defense:** Conservative confidence thresholds. Require strong evidence before auto-execution.

### Failure: Spend limit tracking becomes inconsistent

**Symptom:** System approves actions that, combined, exceed the daily limit.
**Mitigation:** Spend tracking uses serializable transactions in CockroachDB. Concurrent actions are serialized at the database level.
**Design defense:** If spend tracking query fails, assume limit is exhausted. Deny the action.

### Failure: IronClaw executes the wrong action

**Symptom:** The action sent to IronClaw was correct, but IronClaw did something different.
**Mitigation:** Record both the execution plan (what we sent) and the execution result (what happened). Flag discrepancies. Initiate rollback if possible.
**Design defense:** The adapter validates execution results against expected outcomes.

### Failure: Policy engine has a bug that allows an action it should block

**Symptom:** An action bypasses a policy rule.
**Mitigation:** Audit trail shows which policies were evaluated. Post-hoc eval can detect policy violations in historical decisions.
**Design defense:** Policy evaluation is a separate, testable module. Extensive unit tests for edge cases. Default-deny when policy evaluation errors occur.

### Failure: Trust tier promotion happens too quickly

**Symptom:** User is promoted to MODERATE_AUTONOMY before the system has enough evidence of correct judgment.
**Mitigation:** Promotion criteria include minimum action counts, not just success rates. 50+ correct actions at LOW_AUTONOMY before promotion to MODERATE_AUTONOMY.
**Design defense:** Promotion is conservative by default. Users can always manually set their tier lower.

### Failure: System becomes too cautious and escalates everything

**Symptom:** Interruption rate doesn't decrease over time. User gets frustrated.
**Mitigation:** Track escalation rate as a metric. If escalation rate plateaus, investigate: is the twin model learning? Are confidence thresholds too high? Is the user providing feedback?
**Design defense:** Eval harness monitors escalation trends. Stagnation triggers investigation.

### Failure: Database becomes unavailable

**Symptom:** CockroachDB is unreachable.
**Mitigation:** All autonomous actions halt. System enters "safe mode" -- escalates everything with an explanation that normal processing is impaired.
**Design defense:** Health checks monitor database connectivity. Alerting on degraded performance. CockroachDB's distributed architecture provides resilience in production.

### Failure: Adversarial input / prompt injection via event content

**Symptom:** Malicious email content or calendar event attempts to manipulate the decision engine.
**Mitigation:** Event content is treated as untrusted data. Decision logic operates on structured fields, not raw content. Twin model updates require legitimate user feedback channels.
**Design defense:** Strict separation between event data and system logic. No eval() or template injection paths. Content is sanitized before display in explanations.
