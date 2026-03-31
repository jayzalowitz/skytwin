# Issue 006: Build the Policy Engine

**Milestone:** [M1 -- Decision Core](./milestone-1-decision-core.md) (skeleton), [M2 -- Safe Delegation](./milestone-2-safe-delegation.md) (full)
**Priority:** P0 (safety-critical)
**Estimate:** 2-3 days (M1 skeleton) + 4-5 days (M2 expansion) = 6-8 days total
**Assignee:** TBD
**Labels:** `policy-engine`, `safety`, `M1`, `M2`
**Depends on:** [Issue 001](./issue-001-bootstrap-repo.md), [Issue 002](./issue-002-define-core-schemas.md)

## Problem

Every action SkyTwin takes must pass through a safety layer. Without policy enforcement, the system could auto-execute expensive purchases, send emails to the wrong people, cancel important subscriptions, or take irreversible actions the user wouldn't want. The policy engine is the guardrail that prevents the decision engine from doing harm.

## Why It Matters

Trust is the product. If SkyTwin makes one bad autonomous decision -- cancels a flight the user needed, sends a rude reply to a boss, orders $200 of groceries when the user is on vacation -- the user will turn it off and never come back. The policy engine is what makes SkyTwin safe enough to trust.

The safety invariants in CLAUDE.md are not aspirational. They're requirements:
1. Never auto-execute without a policy check.
2. Respect trust tiers.
3. Spend limits are hard limits.
4. Reversibility matters.

The policy engine enforces all of them.

## Scope

### M1: Policy Engine Skeleton

The skeleton version provides basic policy evaluation that the decision engine can integrate with immediately.

#### PolicyEvaluator API

```typescript
interface PolicyEvaluator {
  evaluate(
    action: CandidateAction,
    context: PolicyContext
  ): Promise<PolicyDecision>;

  getUserPolicies(userId: string): Promise<ActionPolicy[]>;
}

interface PolicyContext {
  userId: string;
  trustTier: TrustTier;
  autonomySettings: AutonomySettings;
  dailySpendCents: number;
  activePolicies: ActionPolicy[];
}

interface PolicyDecision {
  effect: 'allow' | 'deny' | 'require_approval';
  reasons: string[];
  appliedRules: AppliedRule[];
  evaluatedAt: Date;
}

interface AppliedRule {
  policyId: string;
  ruleName: string;
  effect: 'allow' | 'deny' | 'require_approval';
  reason: string;
}
```

#### M1 Evaluation Logic

The skeleton evaluator checks the following, in order:

1. **Trust tier gating:**
   - `OBSERVER`: All actions require approval. Effect: `require_approval`.
   - `SUGGEST`: All actions require approval. Effect: `require_approval`.
   - `LOW_AUTONOMY`: Only `RiskTier.NEGLIGIBLE` and `RiskTier.LOW` can auto-execute.
   - `MODERATE_AUTONOMY`: Up to `RiskTier.MODERATE` can auto-execute.
   - `HIGH_AUTONOMY`: Up to `RiskTier.HIGH` can auto-execute. `CRITICAL` always requires approval.

2. **Per-action spend limit:**
   - If `action.estimatedCostCents > autonomySettings.maxSpendPerActionCents`: Effect `require_approval`.
   - Reason: "Action cost ($X.XX) exceeds per-action limit ($Y.YY)".

3. **Daily spend limit:**
   - If `dailySpendCents + action.estimatedCostCents > autonomySettings.maxDailySpendCents`: Effect `require_approval`.
   - Reason: "Daily spend would reach $X.XX, exceeding limit of $Y.YY".

4. **Default safety policies:**
   - If `action.reversible === false` and `autonomySettings.requireApprovalForIrreversible === true`: Effect `require_approval`.
   - Reason: "Action is irreversible and user requires approval for irreversible actions".

5. **User-defined policy rules:**
   - Evaluate rules from `activePolicies` in priority order (highest priority first).
   - First matching rule determines the effect.
   - If no rule matches, default to `allow` (the above checks already catch safety concerns).

The overall effect is the most restrictive result: if any check says `deny`, the effect is `deny`. If any check says `require_approval` and none says `deny`, the effect is `require_approval`. Only if all checks say `allow` is the effect `allow`.

### M2: Full Policy Engine

The M2 expansion adds:

#### Trust Tier Progression

```typescript
interface TrustTierManager {
  evaluateProgression(userId: string): Promise<TierChangeResult>;
  getCurrentTier(userId: string): Promise<TrustTier>;
  getProgressionCriteria(currentTier: TrustTier): ProgressionCriteria;
}

interface ProgressionCriteria {
  requiredApprovals: number;         // How many approved decisions needed
  maxRejectionRate: number;          // Maximum rejection rate (0.0-1.0)
  minTimeAtTierDays: number;         // Minimum days at current tier
  requireExplicitOptIn: boolean;     // For HIGH_AUTONOMY, user must opt in
}

interface TierChangeResult {
  changed: boolean;
  previousTier: TrustTier;
  newTier: TrustTier;
  reason: string;
  auditRecordId: string;
}
```

Progression thresholds:

| From | To | Approvals needed | Max rejection rate | Min time |
|------|----|------------------|--------------------|----------|
| OBSERVER | SUGGEST | 10 | 30% | 3 days |
| SUGGEST | LOW_AUTONOMY | 25 | 20% | 7 days |
| LOW_AUTONOMY | MODERATE_AUTONOMY | 50 | 15% | 14 days |
| MODERATE_AUTONOMY | HIGH_AUTONOMY | 100 | 10% | 30 days + explicit opt-in |

Regression triggers:
- 3 rejections in a row: drop one tier
- Rejection rate exceeds 40% over last 20 decisions: drop one tier
- User explicitly requests lower tier: drop to requested tier
- Critical correction (user undoes an irreversible action): drop to OBSERVER

#### Approval Routing

```typescript
interface ApprovalRouter {
  createApprovalRequest(
    action: CandidateAction,
    context: PolicyContext,
    reason: string,
    urgency: ApprovalUrgency
  ): Promise<ApprovalRequest>;

  getApprovalRequest(id: string): Promise<ApprovalRequest | null>;
  getPendingApprovals(userId: string): Promise<ApprovalRequest[]>;
  respondToApproval(id: string, response: ApprovalResponse): Promise<void>;
  expireStaleApprovals(): Promise<number>;
}

type ApprovalUrgency = 'immediate' | 'soon' | 'normal' | 'low';

interface ApprovalResponse {
  approved: boolean;
  modifiedAction?: Partial<CandidateAction>;
  reason?: string;
}
```

Expiry rules:
- `immediate`: 15 minutes
- `soon`: 2 hours
- `normal`: 24 hours
- `low`: 72 hours

When an approval expires:
- If the action is still relevant (e.g., calendar conflict is still upcoming): re-escalate with higher urgency
- If the action is no longer relevant (e.g., subscription already renewed): mark as expired, no action taken

#### Spend Controls (Enhanced)

```typescript
interface SpendTracker {
  getDailySpend(userId: string, windowStart?: Date): Promise<number>;
  recordSpend(userId: string, amountCents: number, decisionId: string): Promise<void>;
  reconcileSpend(userId: string, decisionId: string, actualCents: number): Promise<SpendReconciliation>;
}

interface SpendReconciliation {
  estimatedCents: number;
  actualCents: number;
  variancePercent: number;
  flagged: boolean;         // True if variance > 20%
}
```

Rolling 24-hour window for daily spend: query `execution_results` joined with `candidate_actions` for the user, where `completed_at` is within the last 24 hours.

#### Reversibility Rules (Enhanced)

- Reversible actions have a configurable grace period:
  - Email actions: 30 seconds (undo send)
  - Calendar actions: 5 minutes
  - Financial actions: 1 hour
  - Grocery orders: until order is confirmed by the store
- During the grace period, the user can undo the action via the approval interface
- After the grace period, the action is considered final

#### Escalation Boundaries

```typescript
interface EscalationEngine {
  shouldEscalate(
    action: CandidateAction,
    context: EnrichedContext,
    riskAssessment: RiskAssessment
  ): EscalationDecision;
}

interface EscalationDecision {
  escalate: boolean;
  reason: string;
  urgency: ApprovalUrgency;
  triggers: EscalationTrigger[];
}

type EscalationTrigger =
  | 'low_confidence'
  | 'high_risk'
  | 'novel_situation'
  | 'conflicting_preferences'
  | 'spend_near_limit'
  | 'irreversible_action'
  | 'blocked_domain'
  | 'quiet_hours';
```

Escalation triggers:
- **Low confidence:** Action confidence is below `MODERATE`
- **High risk:** Risk tier is above what the user's trust tier allows
- **Novel situation:** No preferences or inferences exist for this domain+action combination
- **Conflicting preferences:** Two or more preferences suggest different actions
- **Spend near limit:** Daily spend is within 10% of the limit
- **Irreversible action:** Action is irreversible and has risk tier above NEGLIGIBLE
- **Blocked domain:** Action domain is in the user's blocked list (this should be a deny, not escalation)
- **Quiet hours:** Current time is within the user's quiet hours

#### Domain Controls

```typescript
interface DomainController {
  isDomainAllowed(userId: string, domain: string): Promise<DomainControlResult>;
  getUserDomainPolicies(userId: string): Promise<DomainPolicy[]>;
  setDomainPolicy(userId: string, policy: DomainPolicy): Promise<void>;
}

interface DomainControlResult {
  allowed: boolean;
  reason: string;
  autonomyLevel: TrustTier | null;  // Domain-specific override
  spendLimit: number | null;         // Domain-specific override
}
```

Domain evaluation order:
1. System-wide blocklist (admin-controlled): always deny
2. User blocklist: always deny
3. User allowlist: allow, apply domain-specific autonomy level
4. Not in any list: require approval (fail-safe)

## Implementation Notes

### Rule Evaluation Order

Policy rules are evaluated in a strict order, and the most restrictive result wins:

```
1. System-wide blocklist           → deny
2. User blocklist                  → deny
3. Trust tier gating               → allow | require_approval
4. Spend limits (per-action)       → allow | require_approval
5. Spend limits (daily)            → allow | require_approval
6. Irreversibility check           → allow | require_approval
7. Quiet hours check               → allow | require_approval
8. User-defined policy rules       → allow | deny | require_approval
9. Domain controls                 → allow | deny | require_approval
10. Escalation boundary check      → allow | require_approval
```

Result aggregation: deny > require_approval > allow.

### Determinism

The policy engine must be deterministic: given the same inputs, it must always produce the same output. No randomness, no time-dependent logic (except for quiet hours, which depends on current time passed as an input, not read from the clock).

This is critical for testing and for the eval harness (Issue 010).

### Audit Trail

Every policy evaluation produces an audit record:

```typescript
interface PolicyAuditRecord {
  id: string;
  userId: string;
  decisionId: string;
  actionId: string;
  appliedRules: AppliedRule[];
  finalEffect: 'allow' | 'deny' | 'require_approval';
  evaluatedAt: Date;
}
```

These records are stored in a `policy_audit` table (may need to be added to the schema) and are used by the explanation layer (Issue 008) to explain why an action was allowed, denied, or escalated.

### Testing Strategy

1. **Trust tier truth table:** Test every combination of trust tier x risk tier for correct gating.
2. **Spend limit edge cases:** Test at exactly the limit, one cent over, one cent under.
3. **Policy rule priority:** Test that higher-priority rules override lower-priority ones.
4. **Escalation trigger coverage:** Test each trigger individually and in combination.
5. **Domain control precedence:** Test blocklist > allowlist > default behavior.
6. **Trust tier progression:** Test happy path promotion, regression on rejections, explicit opt-in for HIGH_AUTONOMY.
7. **Approval lifecycle:** Test create, respond, expire for each urgency level.
8. **Determinism:** Run the same evaluation 100 times and assert identical results.

## Acceptance Criteria

### M1 (Skeleton)

- [ ] `PolicyEvaluator.evaluate(action, context)` returns `allow`, `deny`, or `require_approval`.
- [ ] `OBSERVER` and `SUGGEST` trust tiers always return `require_approval`.
- [ ] Per-action spend limit is enforced: cost exceeding limit produces `require_approval`.
- [ ] Daily spend limit is enforced: cumulative spend exceeding limit produces `require_approval`.
- [ ] Irreversible actions with `requireApprovalForIrreversible: true` produce `require_approval`.
- [ ] Every `PolicyDecision` includes human-readable reasons.
- [ ] Default safety policies apply to all users, even those with no custom policies.
- [ ] All tests pass: `pnpm --filter @skytwin/policy-engine test`.

### M2 (Full)

- [ ] Trust tier progression: user advances from OBSERVER to SUGGEST after 10 approved decisions with <30% rejection rate and 3+ days at tier.
- [ ] Trust tier regression: 3 consecutive rejections drops a user one tier.
- [ ] HIGH_AUTONOMY requires explicit opt-in.
- [ ] Approval requests are created with correct urgency and reason.
- [ ] Approval expiry works: immediate expires after 15 minutes, normal after 24 hours.
- [ ] Daily spend tracking uses rolling 24-hour window.
- [ ] Spend reconciliation flags variances >20%.
- [ ] Escalation triggers fire correctly for each trigger type.
- [ ] Domain blocklist always denies; domain not in allowlist defaults to require_approval.
- [ ] Quiet hours enforcement prevents auto-execution during configured quiet hours.
- [ ] Tier changes create audit records with reasoning.
- [ ] Policy evaluation is deterministic (same inputs = same output, tested with 100 iterations).
- [ ] All seven CLAUDE.md safety invariants have dedicated tests.

## Non-Goals

- **Admin UI for policy management:** Policies are managed via API or direct DB writes in M2.
- **Machine learning for policy tuning:** Policies are manually defined rules. ML-based policy adaptation is future work.
- **Multi-user policies:** Policies are per-user. Organizational/team policies are out of scope.
- **Policy versioning:** When a policy changes, the new version replaces the old one. No policy version history (unlike twin profiles).
- **Real-time policy updates:** Policy changes take effect on the next evaluation. No hot-reloading.

## Dependencies

- [Issue 001](./issue-001-bootstrap-repo.md): Workspace structure.
- [Issue 002](./issue-002-define-core-schemas.md): `PolicyRule`, `ActionPolicy`, `DomainPolicy`, `ApprovalRequest`, `TrustTier`, `RiskTier`, `AutonomySettings` types and `action_policies`, `approval_requests` tables.
- [Issue 003](./issue-003-build-twin-model.md): Feedback data for trust tier progression (M2).
- [Issue 005](./issue-005-build-decision-engine.md): The decision engine calls the policy evaluator. They're designed in parallel but integrated in Issue 005.

## Risks and Open Questions

| Item | Type | Notes |
|------|------|-------|
| Trust tier progression thresholds need tuning | Risk | The thresholds (10 approvals for SUGGEST, 25 for LOW_AUTONOMY, etc.) are educated guesses. M4 evals will provide data for tuning. Make them configurable from the start. |
| "Most restrictive wins" can make the system useless | Risk | If a user has conflicting policies (one allows, one denies), deny wins. This is correct for safety but could block legitimate actions. Mitigate by keeping default policies minimal and clear. |
| Approval expiry without notifications means users miss approvals | Risk | M2 limitation. Approval polling endpoint exists but no push notifications. Users who don't check approvals will see them expire. Log expired approvals for monitoring. |
| Policy audit table doesn't exist in current schema | Risk | Need to add `policy_audit` table. This is a schema migration, handled by Issue 002's migration infrastructure. |
| Should domain "not in any list" default to deny or require_approval? | Open question | Decision: `require_approval`. Deny is too strict (blocks all unknown domains). Require_approval lets the user decide and teaches the system about new domains. |
| How to handle conflicting urgency classifications? | Open question | Decision: Use the highest urgency. If one trigger says `immediate` and another says `low`, the approval is `immediate`. Safety over convenience. |
