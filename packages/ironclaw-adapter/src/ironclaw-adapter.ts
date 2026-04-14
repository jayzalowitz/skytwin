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
  buildPlan(action: CandidateAction): Promise<ExecutionPlan>;

  /**
   * Execute a plan and return the result.
   */
  execute(plan: ExecutionPlan): Promise<ExecutionResult>;

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
  executeStreaming(plan: ExecutionPlan): AsyncIterable<ExecutionEvent>;
  registerCredential(name: string, value: string, opts?: { ttlSeconds?: number }): Promise<{ success: boolean }>;
  revokeCredential(name: string): Promise<{ success: boolean }>;
  listCredentials(): Promise<IronClawCredentialInfo[]>;
  sendChatCompletion(messages: ChatMessage[], opts?: { model?: string }): Promise<ChatCompletionResponse>;
  discoverTools(): Promise<IronClawToolManifest[]>;
  createRoutine(schedule: string, plan: ExecutionPlan): Promise<{ routineId: string }>;
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
