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
 * OpenClaw adapter implementing the IronClawAdapter interface.
 *
 * OpenClaw is a community-driven, open-source execution engine that supports
 * a broader set of action types than IronClaw but with weaker guarantees
 * around reversibility and sandboxing.
 *
 * This adapter communicates with an OpenClaw server via HTTP POST to its
 * /execute endpoint. When no server is configured, it falls back to logging
 * the action and returning a completed result (dry-run mode).
 */
export class OpenClawAdapter implements IronClawAdapter {
  private readonly apiUrl: string | null;
  private readonly apiKey: string | null;
  private readonly executedPlans = new Map<string, ExecutionPlan>();

  constructor(config?: { apiUrl?: string; apiKey?: string }) {
    this.apiUrl = config?.apiUrl ?? null;
    this.apiKey = config?.apiKey ?? null;
  }

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

    // OpenClaw has limited rollback support — only for email and calendar actions
    const supportsRollback = action.reversible && (
      action.actionType.includes('email') || action.actionType.includes('calendar')
    );

    const rollbackSteps: ExecutionStep[] = supportsRollback
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
    this.executedPlans.set(plan.id, plan);
    const startedAt = new Date();

    // If a server is configured, send the request
    if (this.apiUrl) {
      try {
        const response = await fetch(`${this.apiUrl}/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            planId: plan.id,
            decisionId: plan.decisionId,
            action: {
              type: plan.action.actionType,
              description: plan.action.description,
              parameters: plan.action.parameters,
              domain: plan.action.domain,
            },
            steps: plan.steps.map((s) => ({
              id: s.id,
              type: s.type,
              description: s.description,
              parameters: s.parameters,
            })),
          }),
          signal: AbortSignal.timeout(plan.steps[0]?.timeout ?? 30000),
        });

        if (!response.ok) {
          return {
            planId: plan.id,
            status: 'failed',
            startedAt,
            completedAt: new Date(),
            error: `OpenClaw returned ${response.status}: ${await response.text()}`,
          };
        }

        const result = await response.json() as Record<string, unknown>;

        return {
          planId: plan.id,
          status: 'completed',
          startedAt,
          completedAt: new Date(),
          output: {
            adapter_used: 'openclaw',
            stepsCompleted: plan.steps.length,
            actionType: plan.action.actionType,
            description: plan.action.description,
            ...(result as Record<string, unknown>),
          },
        };
      } catch (err) {
        return {
          planId: plan.id,
          status: 'failed',
          startedAt,
          completedAt: new Date(),
          error: `OpenClaw execution error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // No server configured — dry-run mode (log and return completed)
    console.info(
      `[openclaw] Dry-run: ${plan.action.actionType} — ${plan.action.description} (plan ${plan.id})`,
    );

    return {
      planId: plan.id,
      status: 'completed',
      startedAt,
      completedAt: new Date(),
      output: {
        adapter_used: 'openclaw',
        mode: 'dry_run',
        stepsCompleted: plan.steps.length,
        actionType: plan.action.actionType,
        description: plan.action.description,
      },
    };
  }

  async rollback(planId: string): Promise<RollbackResult> {
    const plan = this.executedPlans.get(planId);
    if (!plan) {
      return {
        success: false,
        message: `No executed plan found for ID: ${planId}`,
      };
    }

    if (plan.rollbackSteps.length === 0) {
      return {
        success: false,
        message: 'This action is not reversible via OpenClaw. No rollback steps were defined.',
      };
    }

    if (!plan.action.reversible) {
      return {
        success: false,
        message: 'The action is marked as irreversible.',
      };
    }

    // If a server is configured, send the rollback request
    if (this.apiUrl) {
      try {
        const response = await fetch(`${this.apiUrl}/rollback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            planId,
            steps: plan.rollbackSteps.map((s) => ({
              id: s.id,
              type: s.type,
              description: s.description,
              parameters: s.parameters,
            })),
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          return {
            success: false,
            message: `OpenClaw rollback failed with status ${response.status}`,
          };
        }

        return {
          success: true,
          message: `Successfully rolled back ${plan.rollbackSteps.length} step(s) via OpenClaw.`,
        };
      } catch (err) {
        return {
          success: false,
          message: `OpenClaw rollback error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Dry-run mode
    console.info(`[openclaw] Dry-run rollback for plan ${planId}`);
    return {
      success: true,
      message: `Dry-run rollback: ${plan.rollbackSteps.length} step(s) would be rolled back.`,
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    if (!this.apiUrl) {
      // No server configured — report healthy in dry-run mode
      return { healthy: true, latencyMs: 0 };
    }

    const start = Date.now();
    try {
      const response = await fetch(`${this.apiUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      return { healthy: response.ok, latencyMs };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }
}
