import type {
  ActionPolicy,
  CandidateAction,
  RiskAssessment,
  AutonomySettings,
  ConfirmationLevel,
} from '@skytwin/shared-types';
import { RiskTier, TrustTier, evaluateInjectionGuard } from '@skytwin/shared-types';
import { DEFAULT_POLICIES } from './default-policies.js';

/**
 * Port interface for policy persistence.
 *
 * Business logic depends on this interface, not on a concrete database
 * implementation. Adapters (e.g., wrapping @skytwin/db's policyRepository)
 * satisfy this contract at composition time.
 */
export interface PolicyRepositoryPort {
  getAllPolicies(): Promise<ActionPolicy[]>;
  getEnabledPolicies(): Promise<ActionPolicy[]>;
  getPolicy(policyId: string): Promise<ActionPolicy | null>;
  getPoliciesByDomain(domain: string): Promise<ActionPolicy[]>;
  savePolicy(policy: ActionPolicy): Promise<ActionPolicy>;
  updatePolicy(policy: ActionPolicy): Promise<ActionPolicy>;
  deletePolicy(policyId: string): Promise<void>;
}

/**
 * Result of a policy evaluation.
 */
export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  blockingPolicy?: ActionPolicy;
  /**
   * How many deliberate human confirmations the action needs when
   * `requiresApproval` is true. `dual` is set by the injection guard for
   * extreme-severity actions; absent means `single`. Never set when
   * `requiresApproval` is false.
   */
  confirmationLevel?: ConfirmationLevel;
}

/**
 * The PolicyEvaluator checks candidate actions against all applicable policies
 * and user autonomy settings to determine whether an action is allowed,
 * requires approval, or is blocked.
 */
export class PolicyEvaluator {
  /**
   * Operator-controlled kill switch (#379). Read ONCE at construction
   * time from `SKYTWIN_AUTO_EXECUTE_DISABLED=true`. When true, every
   * `evaluate()` call escalates to `requiresApproval: true` regardless
   * of trust tier, autonomy settings, or per-policy rules — the action
   * still lands in the Approvals queue so the user can review +
   * approve, but nothing auto-executes. Independent of the per-user
   * `autonomySettings.paused` lever; either flips the escalation.
   *
   * Override at construction time for tests (so the env-var read isn't
   * a hidden dependency of the unit suite).
   */
  private readonly globallyPaused: boolean;

  constructor(
    private readonly repository: PolicyRepositoryPort,
    options: { globallyPaused?: boolean } = {},
  ) {
    this.globallyPaused = options.globallyPaused
      ?? process.env['SKYTWIN_AUTO_EXECUTE_DISABLED'] === 'true';
  }

  /**
   * Whether the operator-level kill switch was engaged at construction
   * time. Exposed for callers that hold a PolicyEvaluator instance and
   * want the cached snapshot rather than re-reading the env var.
   *
   * The `/api/users/:userId/autonomy-state` endpoint reads
   * `process.env['SKYTWIN_AUTO_EXECUTE_DISABLED']` directly today (the
   * route doesn't have a PolicyEvaluator handle). Both code paths
   * agree by construction — the evaluator snapshots the env var once,
   * the route reads it live. If a future refactor wires the route to
   * use this accessor instead, the snapshot becomes the single source
   * of truth across the process for the lifetime of the evaluator.
   */
  isGloballyPaused(): boolean {
    return this.globallyPaused;
  }

  /**
   * Evaluate a candidate action against all applicable policies and the
   * user's trust tier.
   */
  async evaluate(
    action: CandidateAction,
    policies: ActionPolicy[],
    trustTier: TrustTier,
    riskAssessment?: RiskAssessment,
    autonomySettings?: AutonomySettings,
  ): Promise<PolicyDecision> {
    // Kill-switch state (#379). Captured up front but APPLIED at the
    // very end so it ONLY escalates actions that would otherwise have
    // been allowed — never overrides a deny verdict (spend-cap
    // exceeded, domain blocked, policy deny, untrusted-tier deny) and
    // never strips the injection-guard `confirmationLevel` for
    // extreme-severity actions. Pre-Copilot, this was an early-return
    // ahead of every other check, which turned every deny into an
    // approval (Copilot review on PR #421) and dropped the
    // dual-confirmation guard. Operator pause wins the reason string
    // when both are set so the chrome banner reflects who paused.
    const userPaused = Boolean(autonomySettings?.paused);
    const killSwitchActive = this.globallyPaused || userPaused;
    const killSwitchReason = killSwitchActive
      ? (this.globallyPaused
          ? 'Auto-execution disabled by operator (SKYTWIN_AUTO_EXECUTE_DISABLED). Actions require manual approval until the operator restores normal mode.'
          : 'Auto-execution paused by user. Resume from Settings to let your twin act on signals again.')
      : '';

    // Merge built-in policies with user/provided policies
    const allPolicies = [...DEFAULT_POLICIES, ...policies]
      .filter((p) => p.enabled)
      .sort((a, b) => b.priority - a.priority);

    // Check trust tier gating first. A tier *deny* — now only the fail-closed
    // `default` case for an unrecognized tier — returns here before the
    // injection guard runs. That is intentional and safe: a hard deny is
    // strictly stricter than the guard's escalate-to-approval, so nothing is
    // lost. Every recognized tier returns `allowed: true` (observer and
    // suggest carry `requiresApproval: true`), so it flows past this block
    // into the guard. The guard only needs to run ahead of every path that
    // could *allow or auto-execute* an action (the autonomy-settings check,
    // the quiet-hours early return, the policy loop) — which it does, below.
    // If a future edit makes `checkTrustTierGating` return an `allowed: true`
    // early-return, the guard must be moved above this block.
    const tierDecision = this.checkTrustTierGating(action, trustTier, riskAssessment);
    if (tierDecision && !tierDecision.allowed) {
      return tierDecision;
    }

    // Injection guard — the documentary-poisoning defense. Runs before every
    // check that could allow or auto-execute an action (autonomy settings,
    // the quiet-hours early return, the policy loop), so none of them can
    // skip it. It never denies; it only escalates to single- or
    // dual-confirmation. Its verdict is threaded through every subsequent
    // allowed/approval return path so it cannot be lost or downgraded. A
    // later `deny` still wins (denied beats approval) — that is correct.
    const guard = this.checkInjectionGuard(action);
    let requiresApproval = guard.requiresApproval;
    let confirmationLevel: ConfirmationLevel | undefined = guard.confirmationLevel;
    let approvalReason = guard.reason ?? '';

    // Check autonomy settings if provided
    if (autonomySettings) {
      const settingsDecision = this.checkAutonomySettings(action, autonomySettings, riskAssessment);
      if (settingsDecision && !settingsDecision.allowed) {
        return settingsDecision;
      }
      // Propagate an `allowed: true, requiresApproval: true` verdict
      // (cost-unknown LLM candidate per #372; pre-existing
      // irreversibility branch in checkAutonomySettings) forward into
      // the final merged decision. Without this, the escalation
      // requested by checkAutonomySettings was silently dropped — only
      // the `!allowed` deny path early-returned, and the requiresApproval
      // flag never reached the bottom `requiresApproval ||
      // tierDecision?.requiresApproval` merge.
      if (settingsDecision && settingsDecision.requiresApproval) {
        requiresApproval = true;
        approvalReason = approvalReason
          ? approvalReason
          : (settingsDecision.reason ?? 'Approval required by autonomy settings.');
      }
    }

    // Check quiet hours — escalate auto-execute to approval (not blocking urgent escalations)
    if (autonomySettings) {
      const quietDecision = this.checkQuietHours(autonomySettings);
      if (quietDecision) {
        return {
          ...quietDecision,
          // Preserve every non-negotiable escalation through the
          // quiet-hours early return: the injection-guard confirmation
          // level, the trust tier's own approval requirement
          // (observer/suggest), and the kill-switch pause (#379).
          // Each must outlive every early return that can still
          // return `allowed: true` — observer reaches this path now
          // that it is allow-with-approval rather than a hard deny,
          // and a paused user must not silently bypass via quiet
          // hours either.
          requiresApproval:
            quietDecision.requiresApproval ||
            Boolean(tierDecision?.requiresApproval) ||
            killSwitchActive,
          ...(confirmationLevel ? { confirmationLevel } : {}),
          // Operator/user pause reason wins when both fire — same
          // priority as the end-of-function merge below.
          reason: killSwitchActive
            ? killSwitchReason
            : (approvalReason
                ? `${quietDecision.reason} ${approvalReason}`
                : quietDecision.reason),
        };
      }
    }

    // Evaluate each policy's rules
    for (const policy of allPolicies) {
      const result = this.evaluatePolicy(action, policy, trustTier, riskAssessment);

      if (result === 'deny') {
        return {
          allowed: false,
          requiresApproval: false,
          reason: `Blocked by policy "${policy.name}": ${policy.description}`,
          blockingPolicy: policy,
        };
      }

      if (result === 'require_approval') {
        requiresApproval = true;
        approvalReason = approvalReason
          ? approvalReason
          : `Approval required by policy "${policy.name}": ${policy.description}`;
      }
    }

    // Kill-switch is applied here, AFTER every deny path has had a
    // chance to short-circuit (#379, post-Copilot). Only escalates
    // would-have-been-allowed actions; never overrides a deny verdict.
    // Operator pause reason wins. Confirmation level from the
    // injection guard is preserved either way.
    if (
      requiresApproval ||
      (tierDecision && tierDecision.requiresApproval) ||
      killSwitchActive
    ) {
      // Reason priority when multiple sources agree on requiresApproval:
      //   1. Operator/user pause (most visible, most important to surface)
      //   2. Injection-guard / autonomy-settings / policy approval reason
      //   3. Trust-tier requirement
      //   4. Generic fallback
      const reason = killSwitchActive
        ? killSwitchReason
        : (approvalReason || tierDecision?.reason || 'Approval required by policy.');
      return {
        allowed: true,
        requiresApproval: true,
        reason,
        ...(confirmationLevel ? { confirmationLevel } : {}),
      };
    }

    return {
      allowed: true,
      requiresApproval: false,
      reason: 'All policies passed. Action is allowed for auto-execution.',
    };
  }

  /**
   * Injection guard — the documentary-poisoning defense.
   *
   * Thin adapter over `evaluateInjectionGuard` from `@skytwin/shared-types`.
   * The matrix lives in one pure function there so this policy check and the
   * execution-router backstop consult identical logic and cannot drift. See
   * that function's doc comment for the full matrix and rationale.
   *
   * This guard never denies — it only escalates to single- or
   * dual-confirmation. Missing provenance fails safe (treated as untrusted).
   */
  checkInjectionGuard(action: CandidateAction): {
    requiresApproval: boolean;
    confirmationLevel?: ConfirmationLevel;
    reason?: string;
  } {
    const verdict = evaluateInjectionGuard(action);
    if (!verdict.escalate) {
      return { requiresApproval: false };
    }
    return {
      requiresApproval: true,
      confirmationLevel: verdict.confirmationLevel,
      reason: verdict.reason,
    };
  }

  /**
   * Check if a candidate action's cost is within spend limits.
   */
  checkSpendLimit(
    action: CandidateAction,
    settings: AutonomySettings,
  ): boolean {
    // `costZeroIntent: 'unknown'` (LLM-generated candidates, #372) means
    // the cost is genuinely not yet known — the LLM does not get to
    // declare its own price. Refuse the cap check so the action escalates
    // to the human rather than being silently auto-approved on a default
    // zero. Once a downstream cost-estimation step lands at the execution
    // router (#372 Fix 3, follow-up), this branch can be lifted for
    // candidates whose cost has been re-estimated.
    if (action.costZeroIntent === 'unknown') {
      return false;
    }
    // Verified zero (rule-based generators, DirectExecutionAdapter reads,
    // legacy callers with undefined intent) fast-paths cleanly.
    if (action.estimatedCostCents <= 0) {
      return true;
    }
    return action.estimatedCostCents <= settings.maxSpendPerActionCents;
  }

  /**
   * Check if an irreversible action should be allowed based on risk assessment.
   */
  checkReversibility(
    action: CandidateAction,
    riskAssessment: RiskAssessment,
  ): boolean {
    if (action.reversible) {
      return true;
    }

    // Irreversible actions are only allowed if the overall risk is negligible or low
    return (
      riskAssessment.overallTier === RiskTier.NEGLIGIBLE ||
      riskAssessment.overallTier === RiskTier.LOW
    );
  }

  /**
   * Check if the action's domain is in the user's allowlist.
   */
  checkDomainAllowlist(
    domain: string,
    settings: AutonomySettings,
  ): boolean {
    // If blocked domains are specified, check those first
    if (settings.blockedDomains.length > 0) {
      if (settings.blockedDomains.includes(domain)) {
        return false;
      }
    }

    // If allowed domains are specified, domain must be in the list
    if (settings.allowedDomains.length > 0) {
      return settings.allowedDomains.includes(domain);
    }

    // If neither is specified, all domains are allowed
    return true;
  }

  /**
   * Load all enabled policies from the repository, combined with built-in ones.
   */
  async loadPolicies(): Promise<ActionPolicy[]> {
    const userPolicies = await this.repository.getEnabledPolicies();
    return [...DEFAULT_POLICIES, ...userPolicies];
  }

  // ── Private helpers ──────────────────────────────────────────────

  private evaluatePolicy(
    action: CandidateAction,
    policy: ActionPolicy,
    trustTier: TrustTier,
    riskAssessment?: RiskAssessment,
  ): 'allow' | 'deny' | 'require_approval' | null {
    for (const rule of policy.rules) {
      if (this.ruleMatches(action, rule.condition, trustTier, riskAssessment)) {
        return rule.effect;
      }
    }
    return null;
  }

  private ruleMatches(
    action: CandidateAction,
    condition: { field: string; operator: string; value: unknown },
    trustTier: TrustTier,
    riskAssessment?: RiskAssessment,
  ): boolean {
    const fieldValue = this.resolveField(action, condition.field, trustTier, riskAssessment);

    if (fieldValue === undefined) {
      return false;
    }

    return this.compareValues(fieldValue, condition.operator, condition.value);
  }

  private resolveField(
    action: CandidateAction,
    field: string,
    trustTier: TrustTier,
    riskAssessment?: RiskAssessment,
  ): unknown {
    // Special fields
    if (field === 'trustTier') return trustTier;
    if (field === 'overallRiskTier') return riskAssessment?.overallTier;

    // Risk dimension fields
    if (field.startsWith('riskDimension.') && riskAssessment) {
      const dimension = field.replace('riskDimension.', '');
      const dimAssessment = riskAssessment.dimensions[dimension as keyof typeof riskAssessment.dimensions];
      return dimAssessment?.tier;
    }

    // Action fields
    const actionRecord = action as unknown as Record<string, unknown>;
    return actionRecord[field];
  }

  private compareValues(
    actual: unknown,
    operator: string,
    expected: unknown,
  ): boolean {
    // For risk tier comparisons
    if (this.isRiskTierString(actual) && this.isRiskTierString(expected)) {
      const actualRank = this.riskTierRank(actual as string);
      const expectedRank = this.riskTierRank(expected as string);

      switch (operator) {
        case 'eq': return actualRank === expectedRank;
        case 'neq': return actualRank !== expectedRank;
        case 'gt': return actualRank > expectedRank;
        case 'gte': return actualRank >= expectedRank;
        case 'lt': return actualRank < expectedRank;
        case 'lte': return actualRank <= expectedRank;
        default: return false;
      }
    }

    switch (operator) {
      case 'eq': return actual === expected;
      case 'neq': return actual !== expected;
      case 'gt': return (actual as number) > (expected as number);
      case 'gte': return (actual as number) >= (expected as number);
      case 'lt': return (actual as number) < (expected as number);
      case 'lte': return (actual as number) <= (expected as number);
      case 'in': return Array.isArray(expected) && expected.includes(actual);
      case 'not_in': return Array.isArray(expected) && !expected.includes(actual);
      case 'contains':
        return typeof actual === 'string' && actual.includes(expected as string);
      default:
        return false;
    }
  }

  private checkTrustTierGating(
    _action: CandidateAction,
    trustTier: TrustTier,
    riskAssessment?: RiskAssessment,
  ): PolicyDecision | null {
    switch (trustTier) {
      case TrustTier.OBSERVER:
        // Observer is allow-with-approval, not deny. The twin still never
        // auto-executes at this tier — decision-maker's shouldAutoExecute()
        // returns false for OBSERVER — but actions must surface as approval
        // requests. A hard deny here produced no approval rows at all, which
        // made the observer→suggest promotion path (10 consecutive approvals)
        // permanently unreachable: a new user could never escape observer.
        return {
          allowed: true,
          requiresApproval: true,
          reason: 'Observer trust tier requires approval for all actions.',
        };

      case TrustTier.SUGGEST:
        return {
          allowed: true,
          requiresApproval: true,
          reason: 'Suggest trust tier requires approval for all actions.',
        };

      case TrustTier.LOW_AUTONOMY:
        if (riskAssessment && this.riskTierRank(riskAssessment.overallTier) > this.riskTierRank(RiskTier.LOW)) {
          return {
            allowed: true,
            requiresApproval: true,
            reason: 'Low autonomy tier requires approval for actions above low risk.',
          };
        }
        return null;

      case TrustTier.MODERATE_AUTONOMY:
        if (riskAssessment && this.riskTierRank(riskAssessment.overallTier) > this.riskTierRank(RiskTier.MODERATE)) {
          return {
            allowed: true,
            requiresApproval: true,
            reason: 'Moderate autonomy tier requires approval for actions above moderate risk.',
          };
        }
        return null;

      case TrustTier.HIGH_AUTONOMY:
        if (riskAssessment && riskAssessment.overallTier === RiskTier.CRITICAL) {
          return {
            allowed: true,
            requiresApproval: true,
            reason: 'Even high autonomy tier requires approval for critical-risk actions.',
          };
        }
        return null;

      default:
        // Unrecognized trust tier must be denied — fail closed
        return {
          allowed: false,
          requiresApproval: true,
          reason: `Unrecognized trust tier "${trustTier}". Defaulting to deny.`,
        };
    }
  }

  private checkAutonomySettings(
    action: CandidateAction,
    settings: AutonomySettings,
    riskAssessment?: RiskAssessment,
  ): PolicyDecision | null {
    // Check domain allowlist
    if (!this.checkDomainAllowlist(action.domain, settings)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Domain "${action.domain}" is not in the allowed domains list.`,
      };
    }

    // Cost-unknown branch (#372): an LLM-generated candidate with
    // costZeroIntent='unknown' must NOT be denied outright — the LLM
    // didn't get to declare its own price, so we don't know whether
    // executing would breach the cap. Escalate to human approval rather
    // than silently dropping the candidate. (Pre-fix this fell through
    // the zero-cost fast-path and auto-approved; the dumb default-zero
    // was treated as "free.") Once the execution router gains the
    // cost-estimation step (#372 Fix 3 follow-up), this branch can be
    // lifted for candidates whose cost has been re-estimated.
    if (action.costZeroIntent === 'unknown') {
      return {
        allowed: true,
        requiresApproval: true,
        reason:
          'LLM-generated candidate has no verified cost estimate yet. ' +
          'Requires human approval until cost is verified.',
      };
    }

    // Check spend limits (real, knowable cost case).
    if (!this.checkSpendLimit(action, settings)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason:
          `Action cost (${action.estimatedCostCents} cents) exceeds per-action ` +
          `spend limit (${settings.maxSpendPerActionCents} cents).`,
      };
    }

    // Check reversibility
    if (
      riskAssessment &&
      settings.requireApprovalForIrreversible &&
      !action.reversible
    ) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: 'User settings require approval for irreversible actions.',
      };
    }

    return null;
  }

  /**
   * Check if the current time falls within quiet hours.
   * Escalates auto-execute to approval but does not block.
   * Handles midnight wrap-around (e.g. 22:00 → 07:00).
   */
  private checkQuietHours(
    settings: AutonomySettings,
  ): PolicyDecision | null {
    if (!settings.quietHoursStart || !settings.quietHoursEnd) {
      return null;
    }

    if (!isWithinQuietHours(settings.quietHoursStart, settings.quietHoursEnd)) {
      return null;
    }

    return {
      allowed: true,
      requiresApproval: true,
      reason: `Quiet hours active (${settings.quietHoursStart}–${settings.quietHoursEnd}). Action escalated to approval.`,
    };
  }

  private isRiskTierString(value: unknown): boolean {
    const tiers = ['negligible', 'low', 'moderate', 'high', 'critical'];
    return typeof value === 'string' && tiers.includes(value);
  }

  private riskTierRank(tier: string): number {
    const ranks: Record<string, number> = {
      negligible: 0,
      low: 1,
      moderate: 2,
      high: 3,
      critical: 4,
    };
    return ranks[tier] ?? -1;
  }
}

/**
 * Check if the current time is within a quiet hours window.
 * Handles midnight wrap-around (e.g. start=22:00, end=07:00).
 *
 * @param start - HH:MM format
 * @param end - HH:MM format
 * @param now - optional Date for testing
 */
export function isWithinQuietHours(start: string, end: string, now?: Date): boolean {
  const current = now ?? new Date();
  const currentMinutes = current.getHours() * 60 + current.getMinutes();
  const startMinutes = parseTimeToMinutes(start);
  const endMinutes = parseTimeToMinutes(end);

  if (startMinutes <= endMinutes) {
    // Normal range (e.g. 09:00 - 17:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Midnight wrap (e.g. 22:00 - 07:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}
