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
 * Result of a rollback attempt.
 */
export interface RollbackResult {
  success: boolean;
  message: string;
}
