import { CandidateAction } from './decision.js';

/**
 * A plan to be executed by IronClaw.
 */
export interface ExecutionPlan {
  id: string;
  decisionId: string;
  action: CandidateAction;
  steps: ExecutionStep[];
  rollbackSteps: ExecutionStep[];
  createdAt: Date;
}

/**
 * A single step in an execution plan.
 */
export interface ExecutionStep {
  id: string;
  order: number;
  type: string;
  description: string;
  parameters: Record<string, unknown>;
  timeout: number;
}

/**
 * Result of executing a plan.
 */
export interface ExecutionResult {
  planId: string;
  status: ExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  output?: Record<string, unknown>;
}

/**
 * Status of plan execution.
 */
export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Event emitted while an execution plan is running.
 */
export interface ExecutionEvent {
  planId: string;
  stepId?: string;
  eventType: 'plan_started' | 'step_started' | 'step_completed' | 'step_failed' | 'plan_completed' | 'plan_failed';
  timestamp: Date;
  payload?: Record<string, unknown>;
}

/**
 * Result of a rollback attempt.
 */
export interface RollbackResult {
  success: boolean;
  message: string;
}

/**
 * A handler that can execute and roll back a specific type of action.
 */
export interface ActionHandler {
  readonly actionType: string;
  readonly domain: string;
  canHandle(actionType: string): boolean;
  execute(step: ExecutionStep): Promise<StepResult>;
  rollback(step: ExecutionStep): Promise<StepResult>;
}

/**
 * Result of executing or rolling back a single step.
 */
export interface StepResult {
  success: boolean;
  output?: Record<string, unknown>;
  error?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ChatCompletionChunk {
  delta: string;
  finished: boolean;
}

export interface IronClawToolManifest {
  name: string;
  description: string;
  actionTypes: string[];
  requiresCredentials: string[];
}

export interface IronClawRoutine {
  id: string;
  schedule: string;
  planSummary: string;
  lastRunAt?: Date;
  nextRunAt?: Date;
  enabled: boolean;
}
