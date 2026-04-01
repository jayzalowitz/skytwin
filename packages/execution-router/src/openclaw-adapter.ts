import type {
  CandidateAction,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStep,
  RollbackResult,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';

/**
 * The set of action types the OpenClaw adapter can handle.
 * OpenClaw supports a broader range of action types than IronClaw,
 * including social media, web search, data analysis, and content generation.
 */
export const OPENCLAW_SKILLS = new Set([
  // Standard action types (shared with IronClaw)
  'send_email',
  'archive_email',
  'reply_email',
  'forward_email',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  // Extended action types (OpenClaw-specific)
  'social_media_post',
  'web_search',
  'data_analysis',
  'content_generation',
]);

/**
 * Mock OpenClaw adapter implementing the IronClawAdapter interface.
 *
 * OpenClaw is a community-driven, open-source execution engine that supports
 * a broader set of action types than IronClaw but with weaker guarantees
 * around reversibility and sandboxing.
 */
export class OpenClawAdapter implements IronClawAdapter {
  async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
    const planId = `openclaw_plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date();

    const step: ExecutionStep = {
      id: `step_${planId}_1`,
      order: 1,
      type: action.actionType,
      description: action.description,
      parameters: {
        ...action.parameters,
        actionType: action.actionType,
        domain: action.domain,
        estimatedCostCents: action.estimatedCostCents,
        adapter_used: 'openclaw',
      },
      timeout: 30000,
    };

    const rollbackSteps: ExecutionStep[] = action.reversible
      ? [
          {
            id: `step_${planId}_rollback_1`,
            order: 1,
            type: `rollback_${action.actionType}`,
            description: `Rollback: ${action.description}`,
            parameters: { ...action.parameters, originalActionType: action.actionType },
            timeout: 30000,
          },
        ]
      : [];

    return {
      id: planId,
      decisionId: action.decisionId,
      action,
      steps: [step],
      rollbackSteps,
      createdAt: now,
    };
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    return {
      planId: plan.id,
      status: 'completed',
      startedAt: new Date(),
      completedAt: new Date(),
      output: {
        adapter_used: 'openclaw',
        stepsCompleted: plan.steps.length,
        actionType: plan.action.actionType,
        description: plan.action.description,
      },
    };
  }

  async rollback(_planId: string): Promise<RollbackResult> {
    return {
      success: false,
      message: 'OpenClaw rollback not supported',
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    return {
      healthy: true,
      latencyMs: 50,
    };
  }
}
