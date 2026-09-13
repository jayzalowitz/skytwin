import type {
  ChatMessage,
  ChatCompletionResponse,
  CandidateAction,
  ExecutionEvent,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStatus,
  IronClawRoutine,
  IronClawToolManifest,
  RollbackResult,
} from '@skytwin/shared-types';

/**
 * A typed adapter refusal that proves no external request was started.
 * Only adapter-owned preflight/build code may create this error; it is never
 * accepted after an untrusted request boundary has been entered.
 */
export class PreRequestExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PreRequestExecutionError';
  }
}

export interface ExecutionPlanBuildContext {
  /** True when the plan will be consumed through executeStreaming(). */
  streaming?: boolean;
}

export interface ExecutionRequestPreparation {
  /** Adapter-private proof produced before durable request-start authority is claimed. */
  proof?: unknown;
}

/**
 * Interface for adapting SkyTwin's decision output to IronClaw's execution layer.
 *
 * IronClaw is the underlying execution engine that actually performs actions
 * (sending emails, making API calls, placing orders, etc.). SkyTwin delegates
 * to IronClaw after deciding what to do and confirming it passes all safety checks.
 */
export interface IronClawAdapter {
  /**
   * Build an execution plan from a candidate action.
   */
  buildPlan(action: CandidateAction, context?: ExecutionPlanBuildContext): Promise<ExecutionPlan>;

  /**
   * Complete adapter-specific authorization reads before request-start is
   * claimed. The returned proof is opaque to the router and single-use at the
   * adapter boundary.
   */
  prepareRequestStart?(
    plan: ExecutionPlan,
    context?: ExecutionPlanBuildContext,
  ): Promise<ExecutionRequestPreparation>;

  /**
   * Execute a plan and return the result.
   */
  execute(plan: ExecutionPlan, preparation?: ExecutionRequestPreparation): Promise<ExecutionResult>;

  /**
   * Get the current execution status for a plan.
   */
  getStatus(planId: string): Promise<ExecutionStatus>;

  /**
   * Attempt to roll back a previously executed plan.
   */
  rollback(planId: string): Promise<RollbackResult>;

  /**
   * Check if IronClaw is healthy and reachable.
   */
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number }>;
}

export interface IronClawCredentialInfo {
  name: string;
  configuredAt: string;
  expiresAt?: string;
}

export interface IronClawEnhancedAdapter extends IronClawAdapter {
  executeStreaming(
    plan: ExecutionPlan,
    preparation?: ExecutionRequestPreparation,
  ): AsyncIterable<ExecutionEvent>;
  registerCredential(name: string, value: string, opts?: { ttlSeconds?: number }): Promise<{ success: boolean }>;
  revokeCredential(name: string): Promise<{ success: boolean }>;
  listCredentials(): Promise<IronClawCredentialInfo[]>;
  sendChatCompletion(messages: ChatMessage[], opts?: { model?: string }): Promise<ChatCompletionResponse>;
  discoverTools(): Promise<IronClawToolManifest[]>;
  createRoutine(userId: string, schedule: string, plan: ExecutionPlan): Promise<{ routineId: string }>;
  listRoutines(userId?: string): Promise<IronClawRoutine[]>;
  deleteRoutine(routineId: string): Promise<{ success: boolean }>;
}

export function isIronClawEnhancedAdapter(adapter: IronClawAdapter): adapter is IronClawEnhancedAdapter {
  const candidate = adapter as Partial<Record<keyof IronClawEnhancedAdapter, unknown>>;
  return (
    typeof candidate.executeStreaming === 'function' &&
    typeof candidate.registerCredential === 'function' &&
    typeof candidate.listCredentials === 'function' &&
    typeof candidate.discoverTools === 'function' &&
    typeof candidate.createRoutine === 'function'
  );
}
