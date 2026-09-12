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
import {
  classifyGmailArchiveGenericAction,
  evaluateInjectionGuard,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
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

/** Opaque prepared dispatch bound to one previously selected adapter. */
export interface PreparedExecution {
  readonly selectedAdapter: string;
  readonly routingDecision: RoutingDecision;
  readonly plan: ExecutionPlan;
}

interface PreparedExecutionBinding {
  readonly userId: string;
  readonly adapter: IronClawAdapter;
  readonly trustProfile: RoutingDecision['trustProfile'];
  readonly trustProfileFingerprint: string;
  readonly registryRevision: number;
  readonly selectedAdapter: string;
  readonly routingDecision: RoutingDecision;
  readonly plan: ExecutionPlan;
  readonly fingerprint: string;
  readonly mutationAttempted: () => boolean;
}

interface RoutingDecisionBinding {
  readonly userId: string;
  readonly adapter: IronClawAdapter;
  readonly selectedAdapter: string;
  readonly trustProfile: RoutingDecision['trustProfile'];
  readonly trustProfileFingerprint: string;
  readonly registryRevision: number;
  readonly actionFingerprint: string;
  readonly riskFingerprint: string;
  readonly routingFingerprint: string;
}

export const EXECUTION_FAILURE_CODES = {
  adapterFailed: 'adapter_execution_failed',
  dispatchAmbiguous: 'adapter_dispatch_ambiguous',
  noAdapter: 'adapter_unavailable',
  preparedInvalid: 'prepared_execution_invalid',
  pipelineFailed: 'execution_pipeline_failed',
} as const;

export type ExecutionFailureCode =
  (typeof EXECUTION_FAILURE_CODES)[keyof typeof EXECUTION_FAILURE_CODES];

const EXECUTION_EVENT_TYPES = new Set<ExecutionEvent['eventType']>([
  'plan_started', 'step_started', 'step_completed', 'step_failed', 'plan_completed', 'plan_failed',
]);

function cloneAndDeepFreeze<T>(value: T, onMutation: () => void): T {
  assertPreparedValue(value, '$', new WeakSet<object>());
  const cloneValue = (current: unknown): unknown => {
    if (current === null || typeof current !== 'object') return current;
    if (current instanceof Date) return new Date(current.getTime());
    if (Array.isArray(current)) return current.map((child) => cloneValue(child));
    const clone = Object.create(Object.getPrototypeOf(current) === null ? null : Object.prototype) as Record<string, unknown>;
    for (const [key, child] of Object.entries(current)) {
      Object.defineProperty(clone, key, {
        value: cloneValue(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  };
  const clone = cloneValue(value);
  const freeze = (current: unknown): unknown => {
    if (current === null || typeof current !== 'object') return current;
    if (current instanceof Date) {
      Object.freeze(current);
      return new Proxy(current, {
        get(target, property) {
          if (typeof property === 'string' && property.startsWith('set')) {
            return (): never => {
              onMutation();
              throw new InvariantViolationError('Prepared execution dates are immutable.');
            };
          }
          const member = Reflect.get(target, property, target) as unknown;
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    }
    if (Object.isFrozen(current)) return current;
    const record = current as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      Object.defineProperty(record, key, {
        value: freeze(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    Object.freeze(current);
    return current;
  };
  return freeze(clone) as T;
}

function assertPreparedValue(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null) return;
  if (value === undefined) {
    throw new InvariantViolationError(`Prepared execution contains unsupported undefined data at ${path}.`);
  }
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return;
  if (kind === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new InvariantViolationError(`Prepared execution contains a non-finite number at ${path}.`);
    }
    return;
  }
  if (kind !== 'object') {
    throw new InvariantViolationError(`Prepared execution contains unsupported ${kind} data at ${path}.`);
  }
  const object = value as object;
  if (seen.has(object)) {
    throw new InvariantViolationError(`Prepared execution contains a cycle at ${path}.`);
  }
  seen.add(object);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InvariantViolationError(`Prepared execution contains an invalid Date at ${path}.`);
    }
    if (Reflect.ownKeys(value).length > 0) {
      throw new InvariantViolationError(`Prepared execution contains a decorated Date at ${path}.`);
    }
    seen.delete(object);
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new InvariantViolationError(`Prepared execution contains a non-canonical array at ${path}.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedKeys = new Set<string>(['length']);
    for (let index = 0; index < value.length; index++) {
      const key = String(index);
      expectedKeys.add(key);
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new InvariantViolationError(`Prepared execution contains a sparse or accessor array entry at ${path}[${index}].`);
      }
      assertPreparedValue(descriptor.value, `${path}[${index}]`, seen);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !expectedKeys.has(key)) {
        throw new InvariantViolationError(`Prepared execution contains a non-canonical array property at ${path}.`);
      }
    }
    seen.delete(object);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvariantViolationError(`Prepared execution contains a non-plain object at ${path}.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new InvariantViolationError(`Prepared execution contains a symbol property at ${path}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new InvariantViolationError(`Prepared execution contains an accessor or hidden property at ${path}.${key}.`);
    }
    assertPreparedValue(descriptor.value, `${path}.${key}`, seen);
  }
  seen.delete(object);
}

function canonicalPreparedValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (value instanceof Date) return `["date",${JSON.stringify(value.toISOString())}]`;
  if (Array.isArray(value)) {
    return `["array",[${value.map((child) => canonicalPreparedValue(child)).join(',')}]]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `["object",[${entries.map(([key, child]) =>
    `[${JSON.stringify(key)},${canonicalPreparedValue(child)}]`).join(',')}]]`;
}

function preparedValueFingerprint(value: unknown): string {
  assertPreparedValue(value, '$', new WeakSet<object>());
  return canonicalPreparedValue(value);
}

function preparedFingerprint(plan: ExecutionPlan, routingDecision: RoutingDecision): string {
  return preparedValueFingerprint({ plan, routingDecision });
}

/**
 * Bind every adapter-visible action to the authenticated owner supplied by the
 * caller. The returned object is a detached, deeply immutable copy so neither
 * caller mutation nor an adapter retaining a reference can change the tenant
 * after routing or policy admission.
 */
function bindExecutionOwner(
  action: CandidateAction,
  userId: string,
  onMutation: () => void = () => undefined,
): CandidateAction {
  // Validate before reading or spreading so accessors and exotic containers
  // cannot run code while the security-boundary copy is being constructed.
  assertPreparedValue(action, '$.action', new WeakSet<object>());
  const suppliedUserId = action.parameters['userId'];
  if (suppliedUserId !== undefined && suppliedUserId !== userId) {
    throw new InvariantViolationError(
      'Candidate action userId does not match the execution owner.',
    );
  }
  return cloneAndDeepFreeze({
    ...action,
    parameters: { ...action.parameters, userId },
  }, onMutation);
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

/**
 * The adapter threw after dispatch began. The external result is unknown, so
 * callers must never retry or fall back automatically.
 */
export class AmbiguousExecutionError extends Error {
  readonly adapterName: string;
  readonly code = EXECUTION_FAILURE_CODES.dispatchAmbiguous;

  constructor(adapterName: string, _cause?: unknown) {
    super(EXECUTION_FAILURE_CODES.dispatchAmbiguous);
    this.name = 'AmbiguousExecutionError';
    this.adapterName = adapterName;
  }
}

/** Stable public/audit code; never serializes the original throwable. */
export function executionFailureCode(error: unknown): ExecutionFailureCode {
  if (error instanceof AmbiguousExecutionError) return error.code;
  if (error instanceof NoAdapterError) return EXECUTION_FAILURE_CODES.noAdapter;
  if (error instanceof InvariantViolationError) return EXECUTION_FAILURE_CODES.preparedInvalid;
  return EXECUTION_FAILURE_CODES.pipelineFailed;
}

function decorateExecutionResult(
  result: ExecutionResult,
  adapterName: string,
  routingAdapter: string,
  fallbacksAttempted: number,
  fallbackSkippedReason?: string,
): ExecutionResult {
  const status = result.status;
  let output: Record<string, unknown> = {};
  if (status === 'completed') {
    try {
      output = result.output && typeof result.output === 'object' ? { ...result.output } : {};
    } catch {
      // The adapter already returned a known status. Invalid output metadata
      // must not reinterpret that known result as an ambiguous dispatch.
      output = {};
    }
  }
  return {
    planId: result.planId,
    status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    ...(status === 'completed' ? {} : { error: EXECUTION_FAILURE_CODES.adapterFailed }),
    output: {
      ...output,
      adapter_used: adapterName,
      routing_decision: routingAdapter,
      fallbacks_attempted: fallbacksAttempted,
      ...(fallbackSkippedReason ? { fallback_skipped_reason: fallbackSkippedReason } : {}),
    },
  };
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
  assertGenericExecutionActionAllowed(action);
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

/** The dedicated Gmail archive lifecycle is never a generic router skill. */
function assertGenericExecutionActionAllowed(action: unknown): asserts action is CandidateAction {
  if (!action) {
    throw new InvariantViolationError('ExecutionRouter called without a CandidateAction.');
  }
  const classification = classifyGmailArchiveGenericAction(action);
  if (classification.kind !== 'other') {
    throw new InvariantViolationError(
      classification.kind === 'archive'
        ? 'The archive_email action is reserved for its dedicated execution lifecycle.'
        : 'The generic execution action could not be inspected safely.',
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
 * 5. Fall back only when plan construction proves dispatch never began
 * 6. If no adapter can handle: log a skill gap and throw
 */
export class ExecutionRouter {
  private readonly registry: AdapterRegistry;
  private readonly preparedExecutions = new WeakMap<object, PreparedExecutionBinding>();
  private readonly routingDecisions = new WeakMap<object, RoutingDecisionBinding>();

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
    assertGenericExecutionActionAllowed(action);
    const boundAction = bindExecutionOwner(action, userId);
    assertGenericExecutionActionAllowed(boundAction);
    const capableNames = this.registry.getCapableAdapters(boundAction.actionType);

    if (capableNames.length === 0) {
      const gap = logSkillGap(
        boundAction.actionType,
        boundAction.description,
        [],
        userId,
        boundAction.decisionId,
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
        boundAction.actionType,
        boundAction.description,
        capableNames,
        userId,
        boundAction.decisionId,
      );
      throw new NoAdapterError(gap);
    }

    const modifiedAssessment = applyAdapterRiskModifier(
      riskAssessment,
      entry.trustProfile,
      !boundAction.reversible,
    );

    const riskModifierApplied = modifiedAssessment.overallTier !== riskAssessment.overallTier
      ? entry.trustProfile.riskModifier
      : 0;

    const reasoning = this.buildReasoning(
      primaryName,
      capableNames,
      entry.trustProfile,
      riskModifierApplied,
      boundAction,
    );

    const routingDecision: RoutingDecision = {
      selectedAdapter: primaryName,
      trustProfile: entry.trustProfile,
      riskModifierApplied,
      modifiedRiskAssessment: modifiedAssessment,
      fallbackChain,
      reasoning,
    };
    this.routingDecisions.set(routingDecision, {
      userId,
      adapter: entry.adapter,
      selectedAdapter: primaryName,
      trustProfile: entry.trustProfile,
      trustProfileFingerprint: preparedValueFingerprint(entry.trustProfile),
      registryRevision: this.registry.getRevision(primaryName),
      actionFingerprint: preparedValueFingerprint(boundAction),
      riskFingerprint: preparedValueFingerprint(modifiedAssessment),
      routingFingerprint: preparedValueFingerprint(routingDecision),
    });
    return routingDecision;
  }

  /**
   * Route to the best adapter and execute the action.
   * Falls back only when the primary adapter cannot build a plan. Once an
   * execute method is invoked, failures are terminal or ambiguous.
   */
  async executeWithRouting(
    action: CandidateAction,
    riskAssessment: RiskAssessment,
    userId: string,
    context?: ExecutionContext,
  ): Promise<ExecutionResult> {
    assertGenericExecutionActionAllowed(action);
    assertValidExecutionInputs(action, riskAssessment);
    assertExecutionPermitted(action, context);
    const boundAction = bindExecutionOwner(action, userId);
    const routingDecision = await this.route(boundAction, riskAssessment, userId);

    const adapterChain = [routingDecision.selectedAdapter, ...routingDecision.fallbackChain];
    const attemptedAdapters: string[] = [];
    for (const adapterName of adapterChain) {
      attemptedAdapters.push(adapterName);
      const entry = this.registry.get(adapterName);
      if (!entry) {
        continue;
      }

      let plan: ExecutionPlan;
      try {
        plan = await entry.adapter.buildPlan(boundAction);
      } catch {
        // Plan construction is the only contractually pre-dispatch operation.
        // A fallback is safe because execute() was never invoked.
        continue;
      }

      let result: ExecutionResult;
      try {
        result = await entry.adapter.execute(plan);
      } catch (error) {
        // execute() may have completed its external effect before throwing.
        // Never guess and try a second adapter.
        throw new AmbiguousExecutionError(adapterName, error);
      }

      if (result.status === 'completed') {
        return decorateExecutionResult(
          result, adapterName, routingDecision.selectedAdapter, attemptedAdapters.length - 1,
        );
      }

      // Non-completed results may represent partial execution. Do not fall back.
      return decorateExecutionResult(
        result,
        adapterName,
        routingDecision.selectedAdapter,
        attemptedAdapters.length - 1,
        'previous adapter returned non-completed status, fallback unsafe',
      );
    }

    // No capable adapter could construct a plan without dispatching.
    const gap = logSkillGap(
      boundAction.actionType,
      boundAction.description,
      attemptedAdapters,
      userId,
      boundAction.decisionId,
    );
    throw new NoAdapterError(gap);
  }

  /**
   * Build a plan for an already-selected route without dispatching it. This is
   * the safe seam for a caller to policy-check the adapter-adjusted risk and
   * persist that exact route before the effect begins.
   */
  async prepareExecution(
    action: CandidateAction,
    routingDecision: RoutingDecision,
    userId: string,
    context?: ExecutionContext,
  ): Promise<PreparedExecution> {
    assertGenericExecutionActionAllowed(action);
    assertValidExecutionInputs(action, routingDecision.modifiedRiskAssessment);
    assertExecutionPermitted(action, context);
    let mutationAttempted = false;
    const noteMutation = (): void => { mutationAttempted = true; };
    const boundAction = bindExecutionOwner(action, userId, noteMutation);
    assertGenericExecutionActionAllowed(boundAction);
    const routeBinding = this.routingDecisions.get(routingDecision);
    if (!routeBinding) {
      throw new InvariantViolationError('Routing decision was not issued by this router or was already consumed.');
    }
    this.routingDecisions.delete(routingDecision);
    const entry = this.registry.get(routingDecision.selectedAdapter);
    if (
      !entry ||
      userId !== routeBinding.userId ||
      this.registry.getRevision(routingDecision.selectedAdapter) !== routeBinding.registryRevision ||
      !this.registry.canHandle(routingDecision.selectedAdapter, boundAction.actionType) ||
      entry.adapter !== routeBinding.adapter ||
      entry.trustProfile !== routeBinding.trustProfile ||
      preparedValueFingerprint(entry.trustProfile) !== routeBinding.trustProfileFingerprint ||
      routingDecision.selectedAdapter !== routeBinding.selectedAdapter ||
      preparedValueFingerprint(boundAction) !== routeBinding.actionFingerprint ||
      preparedValueFingerprint(routingDecision.modifiedRiskAssessment) !== routeBinding.riskFingerprint ||
      preparedValueFingerprint(routingDecision) !== routeBinding.routingFingerprint
    ) {
      throw new InvariantViolationError('Routing decision or selected adapter changed before preparation.');
    }
    // The adapter never receives caller-owned mutable objects. The issued
    // handle carries deep-frozen copies, while a router-private WeakMap makes
    // the capability unforgeable and binds it to this exact adapter instance.
    const immutableInputAction = boundAction;
    const builtPlan = await entry.adapter.buildPlan(immutableInputAction);
    const immutablePlan = cloneAndDeepFreeze(builtPlan, noteMutation);
    if (
      immutablePlan.decisionId !== immutableInputAction.decisionId ||
      preparedValueFingerprint(immutablePlan.action) !== preparedValueFingerprint(immutableInputAction)
    ) {
      throw new InvariantViolationError('Prepared plan action does not match the risk-assessed candidate.');
    }
    const immutableRouting = cloneAndDeepFreeze(routingDecision, noteMutation);
    const prepared = Object.freeze({
      selectedAdapter: immutableRouting.selectedAdapter,
      routingDecision: immutableRouting,
      plan: immutablePlan,
    });
    this.preparedExecutions.set(prepared, {
      userId,
      adapter: entry.adapter,
      trustProfile: entry.trustProfile,
      trustProfileFingerprint: preparedValueFingerprint(entry.trustProfile),
      registryRevision: this.registry.getRevision(immutableRouting.selectedAdapter),
      selectedAdapter: immutableRouting.selectedAdapter,
      routingDecision: immutableRouting,
      plan: immutablePlan,
      fingerprint: preparedFingerprint(immutablePlan, immutableRouting),
      mutationAttempted: () => mutationAttempted,
    });
    return prepared;
  }

  /** Dispatch exactly once through the adapter instance bound by prepareExecution. */
  async executePrepared(prepared: PreparedExecution, userId: string): Promise<ExecutionResult> {
    const binding = this.preparedExecutions.get(prepared);
    if (!binding) {
      throw new InvariantViolationError(
        'Prepared execution handle was not issued by this router or was already consumed.',
      );
    }
    assertGenericExecutionActionAllowed(binding.plan.action);
    const entry = this.registry.get(binding.selectedAdapter);
    if (
      userId !== binding.userId ||
      !entry ||
      entry.adapter !== binding.adapter ||
      entry.trustProfile !== binding.trustProfile ||
      preparedValueFingerprint(entry.trustProfile) !== binding.trustProfileFingerprint ||
      this.registry.getRevision(binding.selectedAdapter) !== binding.registryRevision ||
      !this.registry.canHandle(binding.selectedAdapter, binding.plan.action.actionType) ||
      binding.plan.action.parameters['userId'] !== binding.userId
    ) {
      this.preparedExecutions.delete(prepared);
      throw new InvariantViolationError(
        `Prepared adapter "${binding.selectedAdapter}" was removed or replaced before dispatch.`,
      );
    }
    if (
      prepared.selectedAdapter !== binding.selectedAdapter ||
      prepared.routingDecision !== binding.routingDecision ||
      prepared.plan !== binding.plan ||
      binding.mutationAttempted() ||
      preparedFingerprint(binding.plan, binding.routingDecision) !== binding.fingerprint
    ) {
      this.preparedExecutions.delete(prepared);
      throw new InvariantViolationError('Prepared execution handle was mutated before dispatch.');
    }
    // Consume before invoking the adapter. A completion, failure, or ambiguous
    // throw can never reuse this capability and duplicate the external effect.
    this.preparedExecutions.delete(prepared);
    let result: ExecutionResult;
    try {
      result = await binding.adapter.execute(binding.plan);
    } catch (error) {
      throw new AmbiguousExecutionError(binding.selectedAdapter, error);
    }
    return decorateExecutionResult(
      result, binding.selectedAdapter, binding.routingDecision.selectedAdapter, 0,
    );
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
      return {
        result: result.success
          ? { success: true, message: 'adapter_rollback_completed' }
          : { success: false, message: 'adapter_rollback_failed' },
        adapterUsed,
        noAdapter: false,
      };
    } catch {
      // Adapter threw mid-rollback — surface as a failed (not "no adapter")
      // result so the caller reports the failure honestly rather than a stub.
      return {
        result: {
          success: false,
          message: 'adapter_rollback_failed',
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
    assertGenericExecutionActionAllowed(action);
    assertValidExecutionInputs(action, riskAssessment);
    assertExecutionPermitted(action, context);
    const boundAction = bindExecutionOwner(action, userId);
    const routingDecision = await this.route(boundAction, riskAssessment, userId);
    const adapterChain = [routingDecision.selectedAdapter, ...routingDecision.fallbackChain];
    const attemptedAdapters: string[] = [];
    for (const adapterName of adapterChain) {
      attemptedAdapters.push(adapterName);
      const entry = this.registry.get(adapterName);
      if (!entry) continue;

      let plan: ExecutionPlan;
      try {
        plan = await entry.adapter.buildPlan(boundAction);
      } catch {
        // Safe fallback: execute/executeStreaming was never invoked.
        continue;
      }

      if (hasStreamingExecution(entry.adapter)) {
        try {
          let sawTerminalEvent = false;
          for await (const event of entry.adapter.executeStreaming(plan)) {
            if (!EXECUTION_EVENT_TYPES.has(event.eventType)) {
              throw new Error(EXECUTION_FAILURE_CODES.adapterFailed);
            }
            const terminalEvent = event.eventType === 'plan_completed' || event.eventType === 'plan_failed';
            if (terminalEvent) {
              sawTerminalEvent = true;
            }

            yield {
              planId: plan.id,
              eventType: event.eventType,
              timestamp: event.timestamp instanceof Date ? event.timestamp : new Date(),
              payload: {
                ...(event.eventType === 'plan_failed'
                  ? { error: EXECUTION_FAILURE_CODES.adapterFailed }
                  : {}),
                adapter_used: adapterName,
                routing_decision: routingDecision.selectedAdapter,
                fallbacks_attempted: attemptedAdapters.length - 1,
              },
            };
          }

          if (sawTerminalEvent) return;
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
        } catch (error) {
          throw new AmbiguousExecutionError(adapterName, error);
        }
      }

      let result: ExecutionResult;
      try {
        result = await entry.adapter.execute(plan);
      } catch (error) {
        throw new AmbiguousExecutionError(adapterName, error);
      }
      const decorated = decorateExecutionResult(
        result,
        adapterName,
        routingDecision.selectedAdapter,
        attemptedAdapters.length - 1,
        result.status === 'completed'
          ? undefined
          : 'previous adapter returned non-completed status, fallback unsafe',
      );
      const status = decorated.status === 'completed' ? 'plan_completed' : 'plan_failed';

      yield {
        planId: decorated.planId,
        eventType: status,
        timestamp: decorated.completedAt ?? new Date(),
        payload: {
          ...(decorated.status === 'failed' ? { error: EXECUTION_FAILURE_CODES.adapterFailed } : {}),
          adapter_used: adapterName,
          routing_decision: routingDecision.selectedAdapter,
          fallbacks_attempted: attemptedAdapters.length - 1,
        },
      };
      return;
    }

    const gap = logSkillGap(
      boundAction.actionType,
      boundAction.description,
      attemptedAdapters,
      userId,
      boundAction.decisionId,
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
