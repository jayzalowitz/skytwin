import type {
  CandidateAction,
  ExecutionEvent,
  ExecutionPlan,
  RiskAssessment,
  ExecutionResult,
  RoutingDecision,
  SkillGap,
} from '@skytwin/shared-types';
import type { AdapterRegistry } from './adapter-registry.js';
import { applyAdapterRiskModifier } from './risk-modifier.js';
import { logSkillGap } from './skill-gap-logger.js';

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
  ): Promise<ExecutionResult> {
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
   * Route to the best adapter and stream execution progress when supported.
   * Falls back to the existing synchronous execution path for adapters without
   * streaming support.
   */
  async *executeWithRoutingStreaming(
    action: CandidateAction,
    riskAssessment: RiskAssessment,
    userId: string,
  ): AsyncIterable<ExecutionEvent> {
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
