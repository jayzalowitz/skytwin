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
import { PreRequestExecutionError } from '@skytwin/ironclaw-adapter';
import type { ExecutionRequestPreparation } from '@skytwin/ironclaw-adapter';
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
  /** Current persisted IronClaw channel, supplied by the trusted caller. */
  ironclawChannel?: string;
}

export interface ExecutionDispatchLeaseGrant {
  capability: string;
  leaseGeneration: string;
  expiresAt: Date;
}

export interface ExecutionDispatchAuthorityPort {
  start(input: {
    userId: string;
    decisionId: string;
    actionId: string;
    executionPlanId: string;
    adapterName: string;
    expectedAuthorityRevision: string;
    expectedPolicyAuthorityRevision: string;
    expectedAdmissionAuthorityId: string;
    expectedAdmissionAuthorityUpdatedAt: string;
    mcpServerId?: string;
    mcpToolName?: string;
    credentialProvider?: string;
  }): Promise<
    | { success: true; grant: ExecutionDispatchLeaseGrant }
    | { success: false; code: 'authority_revoked' | 'dispatch_replayed'; error: string }
  >;
  terminalize(input: {
    userId: string;
    executionPlanId: string;
    capability: string;
    leaseGeneration: string;
    state: 'completed' | 'failed' | 'ambiguous';
  }): Promise<boolean>;
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
const TRUSTED_PRE_REQUEST_ADAPTERS = new Set([
  'ironclaw', 'direct', 'openclaw', 'mcp-host',
]);

/**
 * Error thrown when no adapter in the registry can handle an action.
 */
export class NoRequestExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NoRequestExecutionError';
  }
}

export class NoAdapterError extends NoRequestExecutionError {
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
export class InvariantViolationError extends NoRequestExecutionError {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}

/**
 * The adapter was invoked but did not provide trustworthy terminal truth.
 * Callers must retain an unresolved/ambiguous state and reconcile out of band;
 * this error never authorizes fallback or a fabricated failed result.
 */
export class AmbiguousExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AmbiguousExecutionError';
  }
}

const ADAPTER_RESERVED_OUTPUT_KEYS = new Set([
  'adapter_used',
  'routing_decision',
  'fallbacks_attempted',
  'fallback_skipped_reason',
  'adapter_plan_id',
  'status',
  'success',
  'rollback_available',
]);

const ROUTER_CONTROL_PARAMETER_KEYS = new Set([
  'executionPlanId',
  'userId',
  'credentialActionId',
  'credentialDecisionId',
  'credentialExecutionPlanId',
  'credentialAuthorityRevision',
  'credentialPolicyAuthorityRevision',
  'dispatchAuthorityId',
  'dispatchAuthorityUpdatedAt',
  'dispatchCapability',
  'dispatchLeaseGeneration',
  'mcpServerId',
  'mcpToolName',
  'ironclawChannel',
]);

// Keep credential fencing aligned with the concrete Direct handlers. Domain is
// descriptive candidate data and cannot decide whether a provider credential
// will be resolved after the generic request-start claim.
const GOOGLE_CREDENTIAL_ACTION_TYPES = new Set([
  'archive_email', 'label_email', 'send_reply', 'reply_email', 'draft_email',
  'send_email', 'delete_email', 'accept_invite', 'decline_invite',
  'propose_alternative', 'tentative_accept',
]);

const MAX_BUFFERED_STREAM_EVENTS = 256;
const MAX_BUFFERED_STREAM_BYTES = 1_048_576;
const MAX_STREAM_VALUE_DEPTH = 16;
const MAX_STREAM_CONTAINER_ENTRIES = 1_024;

interface StreamSizeState {
  bytes: number;
  readonly limit: number;
  readonly seen: WeakSet<object>;
}

/** Conservatively bound adapter-owned progress without serializing a huge value. */
function addStreamValueSize(value: unknown, state: StreamSizeState, depth = 0): boolean {
  if (depth > MAX_STREAM_VALUE_DEPTH) return false;
  const add = (bytes: number): boolean => {
    state.bytes += bytes;
    return state.bytes <= state.limit;
  };
  if (typeof value === 'string') {
    return add(Math.min(value.length, state.limit + 1) * 3 + 2);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return add(32);
  }
  if (value === undefined) return true;
  if (value instanceof Date) return add(32);
  if (typeof value !== 'object' || state.seen.has(value)) return false;
  state.seen.add(value);
  if (!add(2)) return false;

  if (Array.isArray(value)) {
    if (value.length > MAX_STREAM_CONTAINER_ENTRIES) return false;
    for (const child of value) {
      if (!addStreamValueSize(child, state, depth + 1)) return false;
    }
    return true;
  }

  let entries = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    entries += 1;
    if (entries > MAX_STREAM_CONTAINER_ENTRIES ||
        !add(Math.min(key.length, state.limit + 1) * 3 + 2) ||
        !addStreamValueSize((value as Record<string, unknown>)[key], state, depth + 1)) {
      return false;
    }
  }
  return true;
}

function stripRouterControlParameters(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(parameters).filter(([key]) => !ROUTER_CONTROL_PARAMETER_KEYS.has(key)),
  );
}

function hasOwnParameter(action: CandidateAction, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(action.parameters, key);
}

function requiresExactMcpRouting(action: CandidateAction): boolean {
  const targeted = hasOwnParameter(action, 'mcpServerId') || hasOwnParameter(action, 'mcpToolName');
  if (!targeted) return false;
  const serverId = action.parameters['mcpServerId'];
  const toolName = action.parameters['mcpToolName'];
  if (typeof serverId !== 'string' || serverId.trim().length === 0) {
    throw new InvariantViolationError('An explicit MCP action requires a non-empty mcpServerId.');
  }
  if (toolName !== undefined && toolName !== action.actionType) {
    throw new InvariantViolationError('An explicit MCP tool must exactly match the admitted actionType.');
  }
  return true;
}

/** Remove fields whose durable meaning can only be authored by this router. */
function stripAdapterReservedOutput(
  output: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!output) return {};
  return Object.fromEntries(
    Object.entries(output).filter(([key]) => !ADAPTER_RESERVED_OUTPUT_KEYS.has(key)),
  );
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
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

function bindTrustedDispatchAction(action: CandidateAction, userId: string): CandidateAction {
  const trustedAction = structuredClone(action);
  const parameters = { ...trustedAction.parameters };
  for (const key of [
    'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'authorization',
    'actionType', 'domain', 'estimatedCostCents', 'adapter_used',
    '_mcpServerId', '_mcpToolName', '_isRollback', 'originalActionType',
    'ironclawChannel',
  ]) {
    delete parameters[key];
  }
  parameters['userId'] = userId;
  return { ...trustedAction, parameters };
}

function bindExactStepParameters(
  parameters: Record<string, unknown>,
  action: CandidateAction,
  adapterName: string,
  kind: 'step' | 'rollback',
): Record<string, unknown> {
  const canonical = structuredClone(action.parameters);
  for (const [key, expected] of Object.entries(action.parameters)) {
    if (!Object.prototype.hasOwnProperty.call(parameters, key) ||
        !valuesMatch(parameters[key], expected)) {
      throw new InvariantViolationError(`Adapter build plan changed admitted parameter "${key}".`);
    }
  }

  for (const [key, value] of Object.entries(parameters)) {
    if (Object.prototype.hasOwnProperty.call(action.parameters, key)) continue;
    if (key === 'actionType' && value === action.actionType) {
      canonical[key] = action.actionType;
    } else if (key === 'domain' && value === action.domain) {
      canonical[key] = action.domain;
    } else if (key === 'estimatedCostCents' && value === action.estimatedCostCents) {
      canonical[key] = action.estimatedCostCents;
    } else if (key === 'adapter_used' && value === adapterName) {
      canonical[key] = adapterName;
    } else if (kind === 'rollback' && key === 'originalActionType' &&
        value === action.actionType) {
      canonical[key] = action.actionType;
    } else if (kind === 'rollback' && adapterName === 'mcp-host' &&
        key === '_isRollback' && value === true) {
      canonical[key] = true;
    } else if (adapterName === 'mcp-host' && key === '_mcpToolName') {
      const expectedTool = action.actionType;
      if (value !== expectedTool) {
        throw new InvariantViolationError('MCP build plan changed the admitted tool identity.');
      }
      canonical[key] = expectedTool;
    } else if (adapterName === 'mcp-host' && key === '_mcpServerId') {
      const expectedServer = action.parameters['mcpServerId'];
      if (typeof expectedServer !== 'string' || expectedServer.length === 0 ||
          value !== expectedServer) {
        throw new InvariantViolationError('MCP build plan changed the admitted server identity.');
      }
      canonical[key] = expectedServer;
    } else {
      throw new InvariantViolationError(`Adapter build plan introduced executable parameter "${key}".`);
    }
  }
  return canonical;
}

function bindTrustedPlanContext(
  plan: ExecutionPlan,
  action: CandidateAction,
  userId: string,
  adapterName: string,
  grant?: ExecutionDispatchLeaseGrant,
  executionChannel?: string,
): ExecutionPlan {
  const expectedPlanId = action.parameters['executionPlanId'];
  if (typeof expectedPlanId === 'string' && plan.id !== expectedPlanId) {
    throw new InvariantViolationError('Adapter build plan did not preserve the admitted execution identity.');
  }
  if (plan.decisionId !== action.decisionId || !valuesMatch(plan.action, action)) {
    throw new InvariantViolationError('Adapter build plan changed the admitted action identity or effect shape.');
  }
  if (!Array.isArray(plan.steps) || plan.steps.length !== 1) {
    throw new InvariantViolationError('Adapter build plan must contain exactly one admitted executable step.');
  }
  if (!Array.isArray(plan.rollbackSteps) || plan.rollbackSteps.length > 1 ||
      (!action.reversible && plan.rollbackSteps.length !== 0)) {
    throw new InvariantViolationError('Adapter build plan changed the admitted rollback shape.');
  }
  const bind = (
    step: ExecutionPlan['steps'][number],
    index: number,
    kind: 'step' | 'rollback',
  ): ExecutionPlan['steps'][number] => {
    const expectedType = kind === 'step' ? action.actionType : `rollback_${action.actionType}`;
    const expectedDescription = kind === 'step'
      ? action.description
      : `Rollback: ${action.description}`;
    if (step.order !== 1 || step.type !== expectedType ||
        step.description !== expectedDescription || step.timeout !== 30_000) {
      throw new InvariantViolationError(`Adapter build plan changed the admitted ${kind} effect shape.`);
    }
    return {
      ...step,
      // Step identity is router-authored. Adapter-provided identifiers are
      // untrusted evidence and may contain credentials or forge another step.
      id: `${kind}-${index + 1}`,
      order: 1,
      type: expectedType,
      description: expectedDescription,
      timeout: 30_000,
      parameters: {
        ...bindExactStepParameters(step.parameters, action, adapterName, kind),
        userId,
        credentialActionId: action.id,
        credentialDecisionId: action.decisionId,
        credentialExecutionPlanId: plan.id,
        credentialAuthorityRevision: action.parameters['credentialAuthorityRevision'],
        credentialPolicyAuthorityRevision: action.parameters['credentialPolicyAuthorityRevision'],
        ...(grant && adapterName === 'direct' ? {
          dispatchCapability: grant.capability,
          dispatchLeaseGeneration: grant.leaseGeneration,
        } : {}),
      },
    };
  };
  const trustedPlan = {
    ...plan,
    executionOwnerId: userId,
    ...(executionChannel ? { executionChannel } : {}),
    action,
    steps: plan.steps.map((step, index) => bind(step, index, 'step')),
    rollbackSteps: plan.rollbackSteps.map((step, index) => bind(step, index, 'rollback')),
  };
  if (adapterName === 'direct') return trustedPlan;
  return {
    ...trustedPlan,
    action: {
      ...trustedPlan.action,
      parameters: stripRouterControlParameters(trustedPlan.action.parameters),
    },
    steps: trustedPlan.steps.map((step) => ({
      ...step,
      parameters: stripRouterControlParameters(step.parameters),
    })),
    rollbackSteps: trustedPlan.rollbackSteps.map((step) => ({
      ...step,
      parameters: stripRouterControlParameters(step.parameters),
    })),
  };
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
  private readonly dispatchAuthority: ExecutionDispatchAuthorityPort;

  constructor(registry: AdapterRegistry, dispatchAuthority: ExecutionDispatchAuthorityPort) {
    this.registry = registry;
    this.dispatchAuthority = dispatchAuthority;
  }

  private authorityInput(
    action: CandidateAction,
    plan: ExecutionPlan,
    userId: string,
    adapterName: string,
  ): Parameters<ExecutionDispatchAuthorityPort['start']>[0] {
    const authorityRevision = action.parameters['credentialAuthorityRevision'];
    const policyAuthorityRevision = action.parameters['credentialPolicyAuthorityRevision'];
    const admissionAuthorityId = action.parameters['dispatchAuthorityId'];
    const admissionAuthorityUpdatedAt = action.parameters['dispatchAuthorityUpdatedAt'];
    if (typeof authorityRevision !== 'string' || typeof policyAuthorityRevision !== 'string' ||
        typeof admissionAuthorityId !== 'string' ||
        typeof admissionAuthorityUpdatedAt !== 'string') {
      throw new InvariantViolationError('Persisted execution authority revisions are required at request start.');
    }
    return {
      userId,
      decisionId: action.decisionId,
      actionId: action.id,
      executionPlanId: plan.id,
      adapterName,
      expectedAuthorityRevision: authorityRevision,
      expectedPolicyAuthorityRevision: policyAuthorityRevision,
      expectedAdmissionAuthorityId: admissionAuthorityId,
      expectedAdmissionAuthorityUpdatedAt: admissionAuthorityUpdatedAt,
      ...(adapterName === 'mcp-host' ? {
        mcpServerId: action.parameters['mcpServerId'] as string,
        mcpToolName: action.actionType,
      } : {}),
      ...(adapterName === 'direct' && GOOGLE_CREDENTIAL_ACTION_TYPES.has(action.actionType)
        ? { credentialProvider: 'google' }
        : {}),
    };
  }

  private async terminalizeDispatch(
    userId: string,
    planId: string,
    grant: ExecutionDispatchLeaseGrant,
    state: 'completed' | 'failed' | 'ambiguous',
  ): Promise<void> {
    const persisted = await this.dispatchAuthority.terminalize({
      userId,
      executionPlanId: planId,
      capability: grant.capability,
      leaseGeneration: grant.leaseGeneration,
      state,
    });
    if (!persisted) {
      throw new AmbiguousExecutionError('Dispatch terminal state could not be durably linked to its request-start capability.');
    }
  }

  private async startDispatch(
    action: CandidateAction,
    plan: ExecutionPlan,
    userId: string,
    adapterName: string,
  ): Promise<ExecutionDispatchLeaseGrant> {
    let started: Awaited<ReturnType<ExecutionDispatchAuthorityPort['start']>>;
    try {
      started = await this.dispatchAuthority.start(
        this.authorityInput(action, plan, userId, adapterName),
      );
    } catch (error) {
      // The adapter was not invoked by this process, but an interrupted start
      // transaction may have committed or another process may already own the
      // same plan. Without a typed refusal, plan-wide no-effect is not proven.
      throw new AmbiguousExecutionError(
        'Execution request-start authority outcome is ambiguous.',
        { cause: error },
      );
    }
    if (!started.success) {
      if (started.code === 'authority_revoked') {
        throw new NoRequestExecutionError(
          `Execution request-start authority refused: ${started.error}`,
        );
      }
      throw new AmbiguousExecutionError(
        `Execution request-start authority was already consumed: ${started.error}`,
      );
    }
    return started.grant;
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
    // An explicit MCP target is execution authority, not descriptive routing
    // metadata. It can only cross the MCP host boundary whose DB claim checks
    // the exact server/tool opt-in; never reinterpret it through another
    // generic-capable adapter or plugin.
    const exactMcp = requiresExactMcpRouting(action);
    const capableNames = exactMcp
      ? (this.registry.canHandle('mcp-host', action.actionType) ? ['mcp-host'] : [])
      : this.registry.getCapableAdapters(action.actionType);

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
    const dispatchAction = bindTrustedDispatchAction(action, userId);

    const adapterChain = [routingDecision.selectedAdapter, ...routingDecision.fallbackChain];
    const attemptedAdapters: string[] = [];
    let firstAttemptCompleted = false;

    for (const adapterName of adapterChain) {
      // Guard against duplicate execution: if a previous adapter returned a
      // non-'completed' status, the action may have been partially executed.
      if (firstAttemptCompleted) {
        break;
      }

      attemptedAdapters.push(adapterName);
      const entry = this.registry.get(adapterName);
      if (!entry) {
        continue;
      }

      let builtPlan: ExecutionPlan;
      try {
        builtPlan = await entry.adapter.buildPlan(structuredClone(dispatchAction), { streaming: false });
      } catch (error) {
        if (error instanceof PreRequestExecutionError &&
            TRUSTED_PRE_REQUEST_ADAPTERS.has(adapterName)) {
          continue;
        }
        throw new AmbiguousExecutionError(
          `Adapter "${adapterName}" plan preparation could not prove a safe refusal.`,
          { cause: error },
        );
      }

      const unleasedPlan = bindTrustedPlanContext(
        builtPlan, dispatchAction, userId, adapterName, undefined, context?.ironclawChannel,
      );
      let preparation: ExecutionRequestPreparation | undefined;
      try {
        preparation = await entry.adapter.prepareRequestStart?.(unleasedPlan, { streaming: false });
      } catch (error) {
        if (error instanceof PreRequestExecutionError &&
            TRUSTED_PRE_REQUEST_ADAPTERS.has(adapterName)) continue;
        throw new AmbiguousExecutionError(
          `Adapter "${adapterName}" request preparation could not prove a safe refusal.`,
          { cause: error },
        );
      }
      const grant = await this.startDispatch(dispatchAction, unleasedPlan, userId, adapterName);
      const plan = bindTrustedPlanContext(
        builtPlan, dispatchAction, userId, adapterName, grant, context?.ironclawChannel,
      );

      try {
        // No awaited work is permitted between the committed request-start
        // fence above and this sole adapter invocation.
        const result = await entry.adapter.execute(plan, preparation);

        if (result.planId !== plan.id) {
          throw new AmbiguousExecutionError(
            `Adapter "${adapterName}" returned terminal truth for a different execution plan`,
          );
        }

        if (result.status === 'completed') {
          await this.terminalizeDispatch(userId, plan.id, grant, 'completed');
          return {
            ...result,
            output: {
              ...stripAdapterReservedOutput(result.output),
              adapter_used: adapterName,
              routing_decision: routingDecision.selectedAdapter,
              fallbacks_attempted: attemptedAdapters.length - 1,
              adapter_plan_id: plan.id,
              status: result.status,
              success: true,
              rollback_available: plan.rollbackSteps.length > 0,
            },
          };
        }

        if (result.status !== 'failed') {
          throw new AmbiguousExecutionError(
            `Adapter "${adapterName}" returned non-terminal status ${result.status}`,
          );
        }

        // Explicit terminal failure is durable truth. Do not fall through to
        // another adapter because partial execution may still have occurred.
        firstAttemptCompleted = true;
        await this.terminalizeDispatch(userId, plan.id, grant, 'failed');
        return {
          ...result,
          output: {
            ...stripAdapterReservedOutput(result.output),
            adapter_used: adapterName,
            routing_decision: routingDecision.selectedAdapter,
            fallbacks_attempted: attemptedAdapters.length - 1,
            fallback_skipped_reason: 'previous adapter returned non-completed status, fallback unsafe',
            adapter_plan_id: plan.id,
            status: result.status,
            success: false,
            rollback_available: plan.rollbackSteps.length > 0,
          },
        };
      } catch (error) {
        // Once an adapter is invoked, its exception cannot prove whether an
        // external effect committed. Never authorize a second adapter within
        // this call; reconciliation must resolve the ambiguous first attempt.
        try {
          await this.terminalizeDispatch(userId, plan.id, grant, 'ambiguous');
        } catch {
          // Preserve the original ambiguity; the durable row remains
          // request_started/ambiguous and therefore non-replayable.
        }
        if (error instanceof AmbiguousExecutionError) throw error;
        throw new AmbiguousExecutionError(
          `Execution through adapter "${adapterName}" is ambiguous: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }

    // No registered adapter was available in the selected chain.
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
      return {
        result: {
          success: result.success,
          message: result.success
            ? 'The recorded adapter confirmed rollback completion.'
            : 'The recorded adapter could not confirm rollback completion.',
        },
        adapterUsed,
        noAdapter: false,
      };
    } catch (err) {
      // Adapter text is untrusted evidence and may echo provider secrets.
      return {
        result: {
          success: false,
          message: 'The recorded adapter rollback outcome is unavailable.',
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
    const dispatchAction = bindTrustedDispatchAction(action, userId);
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

      let builtPlan: ExecutionPlan;
      try {
        builtPlan = await entry.adapter.buildPlan(structuredClone(dispatchAction), { streaming: true });
      } catch (error) {
        if (error instanceof PreRequestExecutionError &&
            TRUSTED_PRE_REQUEST_ADAPTERS.has(adapterName)) {
          continue;
        }
        throw new AmbiguousExecutionError(
          `Adapter "${adapterName}" plan preparation could not prove a safe refusal.`,
          { cause: error },
        );
      }
      const unleasedPlan = bindTrustedPlanContext(
        builtPlan, dispatchAction, userId, adapterName, undefined, context?.ironclawChannel,
      );
      let preparation: ExecutionRequestPreparation | undefined;
      try {
        preparation = await entry.adapter.prepareRequestStart?.(unleasedPlan, { streaming: true });
      } catch (error) {
        if (error instanceof PreRequestExecutionError &&
            TRUSTED_PRE_REQUEST_ADAPTERS.has(adapterName)) continue;
        throw new AmbiguousExecutionError(
          `Adapter "${adapterName}" request preparation could not prove a safe refusal.`,
          { cause: error },
        );
      }
      const grant = await this.startDispatch(dispatchAction, unleasedPlan, userId, adapterName);
      const plan = bindTrustedPlanContext(
        builtPlan, dispatchAction, userId, adapterName, grant, context?.ironclawChannel,
      );

      try {

        if (hasStreamingExecution(entry.adapter)) {
          let terminalEvent: ExecutionEvent | null = null;
          let activeStepId: string | null = null;
          let nextStepIndex = 0;
          const bufferedEvents: ExecutionEvent[] = [];
          let bufferedBytes = 0;
          for await (const event of entry.adapter.executeStreaming(plan, preparation)) {
            const isTerminal = event.eventType === 'plan_completed' || event.eventType === 'plan_failed';
            if (event.planId !== plan.id) {
              throw new Error('Adapter stream emitted an event for a different execution plan');
            }
            if (terminalEvent) {
              throw new Error(`Adapter emitted an event after terminal ${terminalEvent.eventType}`);
            }
            let canonicalStepId: string | undefined;
            if (event.eventType === 'step_started' || event.eventType === 'step_completed' ||
                event.eventType === 'step_failed') {
              const expectedStep = plan.steps[nextStepIndex];
              if (!expectedStep || event.stepId !== expectedStep.id) {
                throw new Error('Adapter stream emitted an event with an unbound step identity');
              }
              canonicalStepId = expectedStep.id;
              if (event.eventType === 'step_started') {
                if (activeStepId !== null) {
                  throw new Error('Adapter stream emitted duplicate or overlapping step starts');
                }
                activeStepId = expectedStep.id;
              } else {
                if (activeStepId !== null && activeStepId !== expectedStep.id) {
                  throw new Error('Adapter stream emitted a result for a different active step');
                }
                activeStepId = null;
                nextStepIndex += 1;
              }
            } else if (event.stepId !== undefined) {
              throw new Error('Adapter stream attached a step identity to a plan event');
            }
            const adapterPayload = { ...event.payload };
            for (const key of [
              'adapter_used', 'routing_decision', 'fallbacks_attempted', 'fallback_skipped_reason',
              'adapter_plan_id', 'status', 'success', 'rollback_available',
            ]) delete adapterPayload[key];
            const routedEvent = {
              ...event,
              stepId: canonicalStepId,
              payload: {
                ...adapterPayload,
                adapter_used: adapterName,
                routing_decision: routingDecision.selectedAdapter,
                fallbacks_attempted: attemptedAdapters.length - 1,
                ...(isTerminal
                  ? {
                      status: event.eventType === 'plan_completed' ? 'completed' : 'failed',
                      success: event.eventType === 'plan_completed',
                      rollback_available: plan.rollbackSteps.length > 0,
                    }
                  : {}),
              },
            };
            if (!isTerminal && bufferedEvents.length >= MAX_BUFFERED_STREAM_EVENTS) {
              throw new Error('Adapter stream exceeded the buffered event limit.');
            }
            const size = {
              bytes: 0,
              limit: MAX_BUFFERED_STREAM_BYTES - bufferedBytes,
              seen: new WeakSet<object>(),
            };
            if (size.limit < 0 || !addStreamValueSize(routedEvent, size)) {
              throw new Error('Adapter stream exceeded the buffered byte limit.');
            }
            bufferedBytes += size.bytes;
            if (isTerminal) {
              terminalEvent = routedEvent;
            } else {
              bufferedEvents.push(routedEvent);
            }
          }

          if (!terminalEvent) {
            throw new Error('Adapter stream ended without an explicit terminal event');
          }
          await this.terminalizeDispatch(
            userId,
            plan.id,
            grant,
            terminalEvent.eventType === 'plan_completed' ? 'completed' : 'failed',
          );
          firstAttemptCompleted = true;
          for (const event of bufferedEvents) yield event;
          yield terminalEvent;
          return;
        }

        const result = await entry.adapter.execute(plan, preparation);
        if (result.planId !== plan.id) {
          throw new Error('Adapter returned terminal truth for a different execution plan');
        }
        if (result.status !== 'completed' && result.status !== 'failed') {
          throw new Error(`Adapter returned non-terminal status ${result.status}`);
        }
        const status = result.status === 'completed' ? 'plan_completed' : 'plan_failed';
        await this.terminalizeDispatch(userId, plan.id, grant, result.status);
        firstAttemptCompleted = true;

        yield {
          planId: plan.id,
          eventType: status,
          timestamp: result.completedAt ?? new Date(),
          payload: {
            ...stripAdapterReservedOutput(result.output),
            error: result.error,
            adapter_used: adapterName,
            routing_decision: routingDecision.selectedAdapter,
            fallbacks_attempted: attemptedAdapters.length - 1,
            status: result.status,
            success: result.status === 'completed',
            rollback_available: plan.rollbackSteps.length > 0,
            adapter_plan_id: plan.id,
            fallback_skipped_reason: result.status === 'completed'
              ? undefined
              : 'previous adapter returned non-completed status, fallback unsafe',
          },
        };
        return;
      } catch (error) {
        try {
          await this.terminalizeDispatch(userId, plan.id, grant, 'ambiguous');
        } catch {
          // The unresolved durable claim already blocks replay.
        }
        if (error instanceof AmbiguousExecutionError) throw error;
        throw new AmbiguousExecutionError(
          `Streaming execution through adapter "${adapterName}" is ambiguous.`,
          { cause: error },
        );
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
): adapter is {
  executeStreaming(
    plan: ExecutionPlan,
    preparation?: ExecutionRequestPreparation,
  ): AsyncIterable<ExecutionEvent>;
} {
  return typeof (adapter as { executeStreaming?: unknown }).executeStreaming === 'function';
}
