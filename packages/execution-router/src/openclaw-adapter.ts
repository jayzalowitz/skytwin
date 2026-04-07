import type {
  CandidateAction,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStep,
  RollbackResult,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';

/**
 * Credential requirement reported by an OpenClaw server.
 * When a skill needs external API credentials that haven't been configured,
 * OpenClaw returns this in its response so SkyTwin can flag it to the user.
 */
export interface OpenClawCredentialRequirement {
  integration: string;
  integrationLabel: string;
  description?: string;
  fields: Array<{
    key: string;
    label: string;
    placeholder?: string;
    secret?: boolean;
    optional?: boolean;
  }>;
  skills: string[];
}

/**
 * Callback for when OpenClaw reports a credential requirement.
 * The API layer provides an implementation that persists to the DB and notifies users.
 */
export type OnCredentialNeeded = (requirement: OpenClawCredentialRequirement) => void | Promise<void>;

/**
 * The set of action types the OpenClaw adapter can handle.
 * OpenClaw supports a broader range of action types than IronClaw,
 * including social media, web search, data analysis, and content generation.
 */
export const OPENCLAW_SKILLS = new Set([
  // Standard email action types (shared with IronClaw)
  'send_email',
  'archive_email',
  'label_email',
  'reply_email',
  'forward_email',
  // Extended email action types
  'snooze_email',
  'unsubscribe_email',
  'create_filter',
  'move_to_folder',
  // Standard calendar action types (shared with IronClaw)
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'reschedule_event',
  'decline_event',
  // Extended calendar action types
  'set_out_of_office',
  'block_focus_time',
  'find_meeting_time',
  // Extended action types (OpenClaw-specific)
  'social_media_post',
  'web_search',
  'data_analysis',
  'content_generation',
  // Subscription and shopping action types
  'cancel_subscription',
  'downgrade_subscription',
  'renew_subscription',
  'reorder_items',
  'add_to_list',
  // Travel action types
  'book_travel',
  'set_travel_alert',
  // Finance action types
  'pay_bill',
  'categorize_transaction',
  'flag_suspicious_transaction',
  'transfer_funds',
  'record_expense',
  'set_budget_alert',
  // Smart home action types
  'set_thermostat',
  'toggle_lights',
  'lock_door',
  'set_alarm',
  'run_routine',
  // Task management action types
  'create_task',
  'complete_task',
  'assign_task',
  'set_reminder',
  'update_task_priority',
  // Social media action types
  'draft_social_post',
  'schedule_social_post',
  'respond_to_mention',
  'mute_conversation',
  'share_content',
  // Document management action types
  'organize_file',
  'share_document',
  'summarize_document',
  'create_document',
  // Health & wellness action types
  'log_health_metric',
  'set_medication_reminder',
  'book_appointment',
  'reschedule_appointment',
  'flag_health_anomaly',
  // General action types
  'create_note',
  'escalate_to_user',
  'snooze_reminder',
  'save_option',
  'place_order',
]);

/**
 * OpenClaw adapter implementing the IronClawAdapter interface.
 *
 * OpenClaw is a community-driven, open-source execution engine that supports
 * a broader set of action types than IronClaw but with weaker guarantees
 * around reversibility and sandboxing.
 *
 * This adapter communicates with an OpenClaw server via HTTP POST to its
 * /execute endpoint. When no server is configured, execute() throws an error
 * and healthCheck() reports unhealthy — no silent dry-run fallback.
 */
export class OpenClawAdapter implements IronClawAdapter {
  private readonly apiUrl: string | null;
  private readonly apiKey: string | null;
  private readonly executedPlans = new Map<string, ExecutionPlan>();
  private readonly onCredentialNeeded: OnCredentialNeeded | null;

  constructor(config?: { apiUrl?: string; apiKey?: string; onCredentialNeeded?: OnCredentialNeeded }) {
    this.apiUrl = config?.apiUrl ?? null;
    this.apiKey = config?.apiKey ?? null;
    this.onCredentialNeeded = config?.onCredentialNeeded ?? null;
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

        // Check if OpenClaw is reporting that this skill needs credentials
        if (result['credential_required'] && this.onCredentialNeeded) {
          const credReq = result['credential_required'] as Record<string, unknown>;
          try {
            await this.onCredentialNeeded({
              integration: (credReq['integration'] as string) ?? plan.action.actionType,
              integrationLabel: (credReq['label'] as string) ?? plan.action.actionType,
              description: credReq['description'] as string | undefined,
              fields: (credReq['fields'] as Array<{ key: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean }>) ?? [],
              skills: (credReq['skills'] as string[]) ?? [plan.action.actionType],
            });
          } catch {
            // Don't let callback errors block the response
          }

          return {
            planId: plan.id,
            status: 'failed',
            startedAt,
            completedAt: new Date(),
            error: `Credentials needed for ${(credReq['label'] as string) ?? plan.action.actionType}. Check the Setup page.`,
            output: {
              adapter_used: 'openclaw',
              credential_required: true,
              integration: credReq['integration'],
            },
          };
        }

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

    // No server configured — fail explicitly (never silently succeed)
    throw new Error(
      `OpenClaw not configured: set OPENCLAW_API_URL to enable. ` +
      `Cannot execute ${plan.action.actionType} (plan ${plan.id})`,
    );
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

    // No server configured — fail explicitly
    return {
      success: false,
      message: 'OpenClaw not configured: set OPENCLAW_API_URL to enable rollback.',
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    if (!this.apiUrl) {
      // No server configured — report unhealthy
      return { healthy: false, latencyMs: 0 };
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
