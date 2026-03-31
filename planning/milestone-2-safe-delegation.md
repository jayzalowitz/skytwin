# Milestone 2: Safe Delegation

**Status:** Not Started
**Target:** Week 6-8
**Owner:** Core team
**Depends on:** [Milestone 1 -- Decision Core](./milestone-1-decision-core.md)

## Goal

Make the safety layer fully functional. After M2, the system enforces real safety boundaries: trust tiers gate what actions can auto-execute, spend limits are hard limits, irreversible actions get extra scrutiny, domain allowlists and blocklists are respected, and uncertain decisions are reliably escalated to the user via approval routing.

M1 built the skeleton of the policy engine. M2 fills it out into a production-grade safety system.

## Scope

### In scope

- **Trust tier progression:**
  - Define the rules for how a user moves between trust tiers (`OBSERVER` -> `SUGGEST` -> `LOW_AUTONOMY` -> `MODERATE_AUTONOMY` -> `HIGH_AUTONOMY`).
  - Progression based on: number of approved decisions, ratio of approvals to rejections, time at current tier, absence of critical corrections.
  - Regression: trust tier can drop if the user starts rejecting decisions or issuing corrections.
  - Tier changes create audit records with reasoning.
  - Tier transition is never automatic for `HIGH_AUTONOMY` -- requires explicit user opt-in.

- **Approval routing:**
  - When a decision requires approval, create an `ApprovalRequest` with urgency classification.
  - Route approvals to the correct channel (in M2: store in DB and expose via API; push notifications are future work).
  - Handle approval responses: approved (execute), rejected (record feedback), expired (escalate or drop).
  - Timeout handling: approvals expire after a configurable period based on urgency.
  - Batch approvals: user can approve/reject multiple pending requests at once.

- **Spend controls:**
  - Per-action spend limit enforcement (from `AutonomySettings.maxSpendPerActionCents`).
  - Daily spend limit enforcement (from `AutonomySettings.maxDailySpendCents`), tracked via rolling 24-hour window against `execution_results`.
  - Spend tracking: record actual spend after execution; reconcile against estimates.
  - Over-budget alerting: if actual spend exceeds estimated spend by >20%, flag for review.
  - Currency handling: all amounts in cents, no floating point.

- **Reversibility rules:**
  - Actions marked `reversible: false` require higher trust tier or explicit approval.
  - `AutonomySettings.requireApprovalForIrreversible` enforcement.
  - Reversibility assessment is part of risk scoring (already in `RiskDimension.REVERSIBILITY`), but M2 adds hard policy rules around it.
  - Rollback window: reversible actions have a configurable grace period during which they can be undone.

- **Escalation boundaries:**
  - Define clear escalation triggers: confidence below threshold, risk above threshold, novel situation (no matching preferences), conflicting preferences, spend near limit.
  - Escalation produces an `ApprovalRequest` with clear reasoning about why the system couldn't auto-decide.
  - Escalation is never silent -- the user always knows why they're being asked.

- **Domain allowlists/blocklists:**
  - Per-user domain configuration (`AutonomySettings.allowedDomains`, `blockedDomains`).
  - System-wide domain controls (admin-level blocklist for domains SkyTwin should never touch).
  - Domain-specific autonomy levels: a user might allow full autonomy for grocery but require approval for finance.
  - `DomainPolicy` enforcement integrated into the policy evaluation pipeline.

### Out of scope

- Push notifications or real-time approval routing (future).
- Admin dashboard for managing system-wide policies (future).
- Automated trust tier progression based on ML models (M4).
- Multi-user approval workflows (e.g., requiring two approvers).

## Success Criteria

1. **Trust tier gating works:** A `TrustTier.OBSERVER` user cannot auto-execute any action. A `TrustTier.LOW_AUTONOMY` user can auto-execute low-risk actions in allowed domains but not moderate-risk actions.
2. **Trust tier progression works:** After 20 consecutive approvals with no rejections, a user at `SUGGEST` tier is eligible for `LOW_AUTONOMY`. After a burst of rejections, a `MODERATE_AUTONOMY` user drops to `LOW_AUTONOMY`.
3. **Spend limits are enforced:** An action estimating $50 is blocked for a user with a $25 per-action limit, regardless of trust tier. A user who has spent $95 of a $100 daily limit cannot auto-execute a $10 action.
4. **Irreversible actions require approval:** For a user with `requireApprovalForIrreversible: true`, an irreversible action always produces an `ApprovalRequest`, even at `HIGH_AUTONOMY` tier.
5. **Approvals route correctly:** When an action requires approval, an `ApprovalRequest` record is created with the correct urgency, reason, and candidate action details.
6. **Approval expiry works:** An approval request with `urgency: 'immediate'` expires after 15 minutes. A `'normal'` urgency request expires after 24 hours.
7. **Domain controls work:** An action in a blocked domain is always denied. An action in a domain not in the allow list is escalated.
8. **Escalation reasons are clear:** Every `ApprovalRequest` has a human-readable `reason` that explains exactly why the system couldn't auto-decide.
9. **All safety invariants from CLAUDE.md are enforced by tests:** Each of the seven safety invariants has at least one test that verifies enforcement and one test that verifies the system catches violations.

## Issues

| Issue | Title | Status | Estimate |
|-------|-------|--------|----------|
| [006](./issue-006-build-policy-engine.md) | Build the Policy Engine (expanded) | Not started | 4-5 days |

Note: Issue 006 spans M1 and M2. In M1, the skeleton is built (basic evaluation, trust tier check, spend limit check). In M2, the full feature set is implemented (trust tier progression, approval routing, reversibility rules, escalation boundaries, domain controls).

## Detailed Work Breakdown

Since M2 is covered by a single expanded issue, here is the internal work breakdown:

| Work Item | Estimate | Dependencies |
|-----------|----------|--------------|
| Trust tier progression engine | 1.5 days | M1 policy skeleton |
| Trust tier regression logic + audit trail | 1 day | Trust tier progression |
| Approval routing + storage | 1 day | M1 policy skeleton |
| Approval expiry + timeout handling | 0.5 days | Approval routing |
| Daily spend tracking (rolling 24h window) | 1 day | M1 spend limit check |
| Spend reconciliation (estimate vs actual) | 0.5 days | Daily spend tracking |
| Reversibility hard rules | 0.5 days | M1 policy skeleton |
| Escalation trigger engine | 1 day | All above |
| Domain allowlist/blocklist enforcement | 0.5 days | M1 policy skeleton |
| Domain-specific autonomy levels | 0.5 days | Domain allowlist/blocklist |
| Integration tests for all safety invariants | 1.5 days | All above |
| **Total** | **9-10 days** | |

## Dependency Graph

```
M1 (Decision Core)
 └── 006 expanded (Policy Engine)
      ├── Trust tier progression
      │    └── Trust tier regression + audit
      ├── Approval routing
      │    └── Approval expiry
      ├── Daily spend tracking
      │    └── Spend reconciliation
      ├── Reversibility hard rules
      ├── Domain controls
      │    └── Domain-specific autonomy
      └── Escalation trigger engine (depends on all above)
           └── Integration tests (depends on all above)
```

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Trust tier progression thresholds are wrong | Medium | High | Make thresholds configurable per-deployment; start conservative (require more approvals for promotion); tune in M4 with real data |
| Approval routing without notifications is useless in practice | High | Medium | Accept this limitation for M2; design the approval storage layer to support push notifications later; add polling endpoint |
| Spend tracking across time zones is complex | Medium | Low | Use UTC everywhere; rolling 24h window avoids timezone issues |
| Domain classification is ambiguous (e.g., "renew gym membership" -- fitness or finance?) | Medium | Medium | Allow actions to belong to multiple domains; if any domain is blocked, the action is blocked (fail-safe) |
| Over-engineering safety makes the system too conservative | High | Medium | Track escalation rate as a metric; if >80% of decisions are escalated, safety is too tight |

## Safety Philosophy

M2 is the most safety-critical milestone. The design principle is **fail-safe**: when in doubt, escalate. Specific principles:

1. **Deny by default.** If no policy explicitly allows an action, it requires approval.
2. **Hard limits are hard.** Spend limits and domain blocklists cannot be overridden by trust tier or confidence level.
3. **Escalation is not failure.** The system is working correctly when it escalates an uncertain decision. Excessive autonomy is the failure mode.
4. **Audit everything.** Every tier change, approval request, spend check, and policy evaluation is logged with reasoning.
5. **Conservative progression.** It's better to promote slowly than to grant too much autonomy too quickly.

## Exit Criteria

M2 is complete when:
- All success criteria above are verified
- The seven safety invariants from CLAUDE.md each have dedicated test coverage
- A code reviewer can trace any blocked/escalated action from trigger to approval request to reasoning
- The policy engine's behavior is fully deterministic -- same inputs always produce same outputs
