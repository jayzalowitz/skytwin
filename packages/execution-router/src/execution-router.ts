import type {
  CandidateAction,
  ExecutionEvent,
  ExecutionPlan,
  RiskAssessment,
  ExecutionResult,
  RollbackResult,
  RoutingDecision,
  SkillGap,
} from '@skytwin/shared-types';
import { evaluateInjectionGuard } from '@skytwin/shared-types';
import type { AdapterRegistry } from './adapter-registry.js';
import { applyAdapterRiskModifier } from './risk-modifier.js';
import { logSkillGap } from './skill-gap-logger.js';

/**
 * Context the caller threads into the execution methods so the router can
 * distinguish the auto-execute path from the approved-execution path.
 *
 * `approved: true` means the action reached the router through the approval
 * flow — a human clicked (twice, for `dual` actions; the API enforces the
 * count). `approved: false` / absent means the decision engine marked the
 * action `autoExecute` and no human was in the loop.
 */
export interface ExecutionContext {
  approved?: boolean;
}

/**
 * Outcome of routing a rollback request through the registry.
 *
 * `result` is the adapter's own `RollbackResult`. `adapterUsed` records which
 * registered adapter actually serviced the rollback so callers can persist it
 * alongside the rollback audit record. `noAdapter` is the typed failure mode
 * (Code Style: typed result objects for expected failures) — set when no
 * registered adapter could service the rollback, rather than throwing for the
 * recoverable "this server is no longer installed" case.
 */
export interface RollbackRoutingResult {
  result: RollbackResult;
  adapterUsed: string | null;
  /** True when no registered adapter could handle the rollback. */
  noAdapter: boolean;
}

/**
 * Built-in trust ranking for adapter selection. Lower index = higher trust.
 * Dynamically discovered adapters are appended after these, sorted by riskModifier.
 */
const BUILTIN_TRUST_RANKING: readonly string[] = ['ironclaw', 'direct', 'openclaw'];

/**
 * Error thrown when no adapter in the registry can handle an action.
 */
export class NoAdapterError extends Error {
  readonly skillGap: SkillGap;

  constructor(skillGap: SkillGap) {
    super(
      `No adapter can handle action type "${skillGap.actionType}". ` +
        `Attempted: [${skillGap.attemptedAdapters.join(', ')}]`,
    );
    this.name = 'NoAdapterError';
    this.skillGap = skillGap;
  }
}

/**
 * Thrown when a caller violates an execution-pipeline invariant — for example,
 * invoking the router without a `RiskAssessment` (Safety Invariant #7) or with
 * an action whose id does not match the assessment it was paired with.
 *
 * These are programmer errors, not runtime conditions to recover from.
 */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}

function assertValidExecutionInputs(
  action: CandidateAction,
  riskAssessment: RiskAssessment,
): void {
  if (!riskAssessment) {
    throw new InvariantViolationError(
      'ExecutionRouter called without a RiskAssessment. Safety Invariant #7 ' +
        '("Risk assessment is mandatory") forbids executing actions without one.',
    );
  }
  if (!action) {
    throw new InvariantViolationError('ExecutionRouter called without a CandidateAction.');
  }
  if (action.id !== riskAssessment.actionId) {
    throw new InvariantViolationError(
      `RiskAssessment.actionId (${riskAssessment.actionId}) does not match ` +
        `CandidateAction.id (${action.id}). Refusing to execute with a mismatched assessment.`,
    );
  }
}

/**
 * Defense-in-depth backstop for the documentary-poisoning guard.
 *
 * The policy engine's `checkInjectionGuard` is the primary gate — it escalates
 * injection-risky actions to human approval so they never get `autoExecute`.
 * This backstop catches the case where a bug in the policy engine or decision
 * engine lets an escalation-worthy action reach the router anyway with the
 * auto-execute path (no `approved` context).
 *
 * It consults `evaluateInjectionGuard` — the exact same pure function the
 * policy engine uses — so the two cannot drift. If that function says the
 * action should have been escalated and the caller did not present an
 * `approved` context, the router refuses to execute. Approved-execution
 * callers (the approval flow, after the human clicked) pass `{ approved: true }`
 * and pass straight through — the human already provided the confirmation the
 * guard demanded.
 *
 * This never silently downgrades an action; it throws, loudly, because
 * reaching here on the auto-execute path is a programmer error upstream.
 */
function assertExecutionPermitted(
  action: CandidateAction,
  context?: ExecutionContext,
): void {
  const verdict = evaluateInjectionGuard(action);
  if (verdict.escalate && !context?.approved) {
    throw new InvariantViolationError(
      `Injection-guard backstop: refusing to auto-execute action ` +
        `"${action.actionType}" (id ${action.id}). ${verdict.reason ?? ''} ` +
        `This action reached the execution router on the auto-execute path, ` +
        `but the injection guard requires human ` +
        `${verdict.confirmationLevel === 'dual' ? 'two-step ' : ''}confirmation. ` +
        `A policy-engine or decision-engine change let an escalation-worthy ` +
        `action through with autoExecute — that upstream bug must be fixed. ` +
        `Safety Invariant #1.`,
    );
  }
}

/**
 * Execution router that selects the best adapter for a given action,
 * applies adapter-specific risk modifiers, and executes with fallback.
 *
 * Routing logic:
 * 1. Get all adapters that can handle the action type
 * 2. Sort by trust ranking (ironclaw > direct > openclaw)
 * 3. Apply risk modifier for the selected adapter
 * 4. If irreversible action + adapter has riskModifier > 0, bump risk tier
 * 5. Try primary adapter, fall back through the chain on failure
 * 6. If no adapter can handle: log a skill gap and throw
 */
export class ExecutionRouter {
  private readonly registry: AdapterRegistry;

  constructor(registry: AdapterRegistry) {
    this.registry = registry;
  }

  /**
   * Expose the registry for status/health queries (e.g. the Setup page).
   */
  getRegistry(): AdapterRegistry {
    return this.registry;
  }

  /**
   * Select the best adapter for the given action and return a routing decision.
   */
  async route(
    action: CandidateAction,
    riskAssessment: RiskAssessment,
    userId: string,
  ): Promise<RoutingDecision> {
    const capableNames = this.registry.getCapableAdapters(action.actionType);

    if (capableNames.length === 0) {
      const gap = logSkillGap(
        action.actionType,
        action.description,
        [],
        userId,
        action.decisionId,
      );
      throw new NoAdapterError(gap);
    }

    // Sort by trust ranking
    const sorted = this.sortByTrust(capableNames);
    const primaryName = sorted[0]!;
    const fallbackChain = sorted.slice(1);

    const entry = this.registry.get(primaryName);
    if (!entry) {
      // Shouldn't happen given the earlier check, but satisfy the type system
      const gap = logSkillGap(
        action.actionType,
        action.description,
        capableNames,
        userId,
        action.decisionId,
      );
      throw new NoAdapterError(gap);
    }

    const modifiedAssessment = applyAdapterRiskModifier(
      riskAssessment,
      entry.trustProfile,
      !action.reversible,
    );

    const riskModifierApplied = modifiedAssessment.overallTier !== riskAssessment.overallTier
      ? entry.trustProfile.riskModifier
      : 0;

    const reasoning = this.buildReasoning(
      primaryName,
      capableNames,
      entry.trustProfile,
      riskModifierApplied,
      action,
    );

    return {
      selectedAdapter: primaryName,
      trustProfile: entry.trustProfile,
      riskModifierApplied,
      modifiedRiskAssessment: modifiedAssessment,
      fallbackChain,
      reasoning,
    };
  }

  /**
   * Route to the best adapter and execute the action.
   * Falls back through the chain if the primary adapter fails.
   */
  async executeWithRouting(
    action: CandidateAction,
    riskAssessment: RiskAssessment,
    userId: string,
    context?: ExecutionContext,
  ): Promise<ExecutionResult> {
    assertValidExecutionInputs(action, riskAssessment);
    assertExecutionPermitted(action, context);
    const routingDecision = await this.route(action, riskAssessment, userId);

    const adapterChain = [routingDecision.selectedAdapter, ...routingDecision.fallbackChain];
    const attemptedAdapters: string[] = [];
    let firstAttemptCompleted = false;

    for (const adapterName of adapterChain) {
      // Guard against duplicate execution: if a previous adapter returned a
      // non-'completed' status (rather than throwing), the action may have been
      // partially executed. Only fall back on thrown errors, not on soft failures.
      if (firstAttemptCompleted) {
        break;
      }

      attemptedAdapters.push(adapterName);
      const entry = this.registry.get(adapterName);
      if (!entry) {
        continue;
      }

      try {
        const plan = await entry.adapter.buildPlan(action);
        const result = await entry.adapter.execute(plan);

        if (result.status === 'completed') {
          return {
            ...result,
            output: {
              ...result.output,
              adapter_used: adapterName,
              routing_decision: routingDecision.selectedAdapter,
              fallbacks_attempted: attemptedAdapters.length - 1,
            },
          };
        }

        // Adapter returned a non-completed status (partial execution possible).
        // Do NOT fall through to the next adapter — that risks duplicate actions.
        firstAttemptCompleted = true;
        return {
          ...result,
          output: {
            ...result.output,
            adapter_used: adapterName,
            routing_decision: routingDecision.selectedAdapter,
            fallbacks_attempted: attemptedAdapters.length - 1,
            fallback_skipped_reason: 'previous adapter returned non-completed status, fallback unsafe',
          },
        };
      } catch {
        // Adapter threw before execution started — safe to try next in chain
      }
    }

    // All adapters failed (threw errors)
    const gap = logSkillGap(
      action.actionType,
      action.description,
      attemptedAdapters,
      userId,
      action.decisionId,
    );
    throw new NoAdapterError(gap);
  }

  /**
   * Roll back a previously executed plan by routing to the adapter that ran it.
   *
   * Rollback is fundamentally different from execution routing: it must target
   * the SAME adapter that executed the plan, because each adapter keeps its own
   * in-memory plan store keyed by `planId` (see the mock/real IronClaw adapters
   * and OpenClawAdapter). Re-running the trust-ranked selection from
   * `executeWithRouting` would pick whichever adapter ranks highest today, not
   * the one that actually performed the action — so we resolve the adapter by
   * the `adapterUsed` name persisted at execution time (`execution_results`
   * `outputs.adapter_used`).
   *
   * Resolution order:
   *   1. If `adapterUsed` names a registered adapter, dispatch to it.
   *   2. If `adapterUsed` is unknown/unregistered (e.g. the capability was
   *      uninstalled, or older rows that predate adapter_used persistence),
   *      return `noAdapter: true` — we will NOT guess a different adapter and
   *      ask it to roll back a plan it never executed. Lying about which
   *      adapter can undo the work is worse than honest "no adapter".
   *
   * This never throws for the expected "adapter gone" case; it returns a typed
   * result object (Code Style). It only surfaces adapter-thrown errors as a
   * failed `RollbackResult`.
   */
  async rollback(
    planId: string,
    adapterUsed: string | null | undefined,
  ): Promise<RollbackRoutingResult> {
    // Only an adapter that actually executed the plan can roll it back, and the
    // only reliable record of that is the persisted adapter name. An absent or
    // unrecognized name fails safe — never fall back to a different adapter.
    if (!adapterUsed) {
      return {
        result: {
          success: false,
          message:
            'Cannot roll back: no adapter was recorded for this plan. The ' +
            'executing adapter is unknown, so no rollback target can be resolved.',
        },
        adapterUsed: null,
        noAdapter: true,
      };
    }

    const entry = this.registry.get(adapterUsed);
    if (!entry) {
      return {
        result: {
          success: false,
          message:
            `Cannot roll back: adapter "${adapterUsed}" that executed this plan ` +
            `is no longer registered (the capability may have been uninstalled).`,
        },
        adapterUsed,
        noAdapter: true,
      };
    }

    try {
      const result = await entry.adapter.rollback(planId);
      return { result, adapterUsed, noAdapter: false };
    } catch (err) {
      // Adapter threw mid-rollback — surface as a failed (not "no adapter")
      // result so the caller reports the failure honestly rather than a stub.
      return {
        result: {
          success: false,
          message: `Rollback via adapter "${adapterUsed}" threw: ${err instanceof Error ? err.message : String(err)}`,
        },
        adapterUsed,
        noAdapter: false,
      };
    }
  }

  /**
   * Route to the best adapter and stream execution progress when supported.
   * Falls back to the existing synchronous execution path for adapters without
   * streaming support.
   */
  async *executeWithRoutingStreaming(
    action: CandidateAction,
    riskAssessment: RiskAssessment,
    userId: string,
    context?: ExecutionContext,
  ): AsyncIterable<ExecutionEvent> {
    assertValidExecutionInputs(action, riskAssessment);
    assertExecutionPermitted(action, context);
    const routingDecision = await this.route(action, riskAssessment, userId);
    const adapterChain = [routingDecision.selectedAdapter, ...routingDecision.fallbackChain];
    const attemptedAdapters: string[] = [];
    let firstAttemptCompleted = false;

    for (const adapterName of adapterChain) {
      if (firstAttemptCompleted) {
        break;
      }

      attemptedAdapters.push(adapterName);
      const entry = this.registry.get(adapterName);
      if (!entry) continue;

      try {
        const plan = await entry.adapter.buildPlan(action);

        if (hasStreamingExecution(entry.adapter)) {
          let sawTerminalEvent = false;
          for await (const event of entry.adapter.executeStreaming(plan)) {
            const terminalEvent = event.eventType === 'plan_completed' || event.eventType === 'plan_failed';
            if (terminalEvent) {
              sawTerminalEvent = true;
              firstAttemptCompleted = true;
            }

            yield {
              ...event,
              payload: {
                ...event.payload,
                adapter_used: adapterName,
                routing_decision: routingDecision.selectedAdapter,
                fallbacks_attempted: attemptedAdapters.length - 1,
              },
            };
          }

          if (sawTerminalEvent) return;
          firstAttemptCompleted = true;
          yield {
            planId: plan.id,
            eventType: 'plan_completed',
            timestamp: new Date(),
            payload: {
              adapter_used: adapterName,
              routing_decision: routingDecision.selectedAdapter,
              fallbacks_attempted: attemptedAdapters.length - 1,
            },
          };
          return;
        }

        const result = await entry.adapter.execute(plan);
        const status = result.status === 'completed' ? 'plan_completed' : 'plan_failed';
        firstAttemptCompleted = true;

        yield {
          planId: result.planId,
          eventType: status,
          timestamp: result.completedAt ?? new Date(),
          payload: {
            ...result.output,
            error: result.error,
            adapter_used: adapterName,
            routing_decision: routingDecision.selectedAdapter,
            fallbacks_attempted: attemptedAdapters.length - 1,
            fallback_skipped_reason: result.status === 'completed'
              ? undefined
              : 'previous adapter returned non-completed status, fallback unsafe',
          },
        };
        return;
      } catch {
        // Adapter threw before execution started — safe to try next in chain.
      }
    }

    const gap = logSkillGap(
      action.actionType,
      action.description,
      attemptedAdapters,
      userId,
      action.decisionId,
    );
    throw new NoAdapterError(gap);
  }

  /**
   * Sort adapter names by trust ranking. Adapters not in the ranking
   * are placed at the end in their original order.
   */
  private sortByTrust(names: string[]): string[] {
    return [...names].sort((a, b) => {
      const aBuiltin = BUILTIN_TRUST_RANKING.indexOf(a);
      const bBuiltin = BUILTIN_TRUST_RANKING.indexOf(b);

      // Built-in adapters always rank first, in their declared order
      if (aBuiltin !== -1 && bBuiltin !== -1) return aBuiltin - bBuiltin;
      if (aBuiltin !== -1) return -1;
      if (bBuiltin !== -1) return 1;

      // Discovered adapters: sort by riskModifier (lower = more trusted)
      const aEntry = this.registry.get(a);
      const bEntry = this.registry.get(b);
      const aRisk = aEntry?.trustProfile.riskModifier ?? 99;
      const bRisk = bEntry?.trustProfile.riskModifier ?? 99;
      return aRisk - bRisk;
    });
  }

  /**
   * Build a human-readable reasoning string for the routing decision.
   */
  private buildReasoning(
    selectedName: string,
    capableNames: string[],
    trustProfile: import('@skytwin/shared-types').AdapterTrustProfile,
    riskModifierApplied: number,
    action: CandidateAction,
  ): string {
    const parts: string[] = [];

    parts.push(
      `Selected "${selectedName}" from ${capableNames.length} capable adapter(s): [${capableNames.join(', ')}].`,
    );

    parts.push(
      `Trust profile: reversibility=${trustProfile.reversibilityGuarantee}, auth=${trustProfile.authModel}, audit=${trustProfile.auditTrail}.`,
    );

    if (riskModifierApplied > 0) {
      parts.push(
        `Risk modifier of +${riskModifierApplied} tier(s) applied because action "${action.actionType}" is irreversible and adapter has riskModifier=${trustProfile.riskModifier}.`,
      );
    }

    return parts.join(' ');
  }
}

function hasStreamingExecution(
  adapter: unknown,
): adapter is { executeStreaming(plan: ExecutionPlan): AsyncIterable<ExecutionEvent> } {
  return typeof (adapter as { executeStreaming?: unknown }).executeStreaming === 'function';
}
