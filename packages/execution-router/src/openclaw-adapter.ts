import type {
  CandidateAction,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStatus,
  ExecutionStep,
  RollbackResult,
} from '@skytwin/shared-types';
import { OPENCLAW_ACTION_TYPES } from '@skytwin/shared-types';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';

/**
 * Credential requirement reported by an OpenClaw server.
 * When a skill needs external API credentials that haven't been configured,
 * OpenClaw returns this in its response so SkyTwin can flag it to the user.
 */
export interface OpenClawCredentialRequirement {
  userId: string;
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

const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]*$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(record).every((key) => set.has(key));
}

function boundedText(value: unknown, max: number, required = true): value is string {
  return typeof value === 'string' && value.length <= max && SAFE_TEXT.test(value)
    && (!required || value.trim().length > 0);
}

function parseCredentialRequirement(
  value: unknown,
  userId: unknown,
  actionType: string,
): OpenClawCredentialRequirement | null {
  if (!isPlainRecord(value) || !boundedText(userId, 128) || !SAFE_USER_ID.test(userId)) return null;
  if (!hasOnlyKeys(value, ['integration', 'label', 'description', 'fields', 'skills'])) return null;
  const integration = value['integration'] ?? actionType;
  const label = value['label'] ?? actionType;
  if (!boundedText(integration, 64) || !SAFE_SLUG.test(integration)) return null;
  if (!boundedText(label, 80)) return null;
  if (value['description'] !== undefined && !boundedText(value['description'], 500, false)) return null;
  const rawFields = value['fields'] ?? [];
  const rawSkills = value['skills'] ?? [actionType];
  if (!Array.isArray(rawFields) || rawFields.length > 20) return null;
  if (!Array.isArray(rawSkills) || rawSkills.length > 50) return null;

  const fieldKeys = new Set<string>();
  const fields: OpenClawCredentialRequirement['fields'] = [];
  for (const candidate of rawFields) {
    if (!isPlainRecord(candidate) || !hasOnlyKeys(candidate, ['key', 'label', 'placeholder', 'secret', 'optional'])) return null;
    if (!boundedText(candidate['key'], 64) || !SAFE_SLUG.test(candidate['key']) || fieldKeys.has(candidate['key'])) return null;
    if (!boundedText(candidate['label'], 80)) return null;
    if (candidate['placeholder'] !== undefined && !boundedText(candidate['placeholder'], 120, false)) return null;
    if (candidate['secret'] !== undefined && typeof candidate['secret'] !== 'boolean') return null;
    if (candidate['optional'] !== undefined && typeof candidate['optional'] !== 'boolean') return null;
    fieldKeys.add(candidate['key']);
    fields.push({
      key: candidate['key'], label: candidate['label'],
      ...(candidate['placeholder'] !== undefined ? { placeholder: candidate['placeholder'] as string } : {}),
      ...(candidate['secret'] !== undefined ? { secret: candidate['secret'] as boolean } : {}),
      ...(candidate['optional'] !== undefined ? { optional: candidate['optional'] as boolean } : {}),
    });
  }
  const skills = rawSkills;
  if (!skills.every((skill) => boundedText(skill, 64) && SAFE_SLUG.test(skill))) return null;
  if (new Set(skills).size !== skills.length) return null;
  return {
    userId,
    integration,
    integrationLabel: label,
    ...(value['description'] !== undefined ? { description: value['description'] as string } : {}),
    fields,
    skills: skills as string[],
  };
}

/**
 * The set of action types the OpenClaw adapter can handle.
 * OpenClaw supports a broader range of action types than IronClaw,
 * including social media, web search, data analysis, and content generation.
 */
export const OPENCLAW_SKILLS = new Set(OPENCLAW_ACTION_TYPES);

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
  private readonly executionResults = new Map<string, ExecutionResult>();
  private readonly onCredentialNeeded: OnCredentialNeeded | null;

  constructor(config?: { apiUrl?: string; apiKey?: string; onCredentialNeeded?: OnCredentialNeeded }) {
    this.apiUrl = config?.apiUrl ?? null;
    this.apiKey = config?.apiKey ?? null;
    this.onCredentialNeeded = config?.onCredentialNeeded ?? null;
  }

  async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
    const planId = (action.parameters['executionPlanId'] as string | undefined)
      ?? `openclaw_plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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
    this.executionResults.set(plan.id, { planId: plan.id, status: 'running', startedAt });

    // If a server is configured, send the request
    if (this.apiUrl) {
      let response: Response;
      try {
        response = await fetch(`${this.apiUrl}/execute`, {
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
      } catch {
        throw new Error('openclaw_transport_error');
      }

      if (!response.ok) {
        return this.recordExecutionResult({
          planId: plan.id,
          status: 'failed',
          startedAt,
          completedAt: new Date(),
          // Never promote a peer-controlled response body into logs, API
          // responses, or the durable execution audit.
          error: `openclaw_http_${response.status}`,
        });
      }

      let result: Record<string, unknown>;
      try {
        const parsed = await response.json() as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('invalid');
        }
        result = parsed as Record<string, unknown>;
      } catch {
        throw new Error('openclaw_response_invalid');
      }

      // Check if OpenClaw is reporting that this skill needs credentials.
      if (result['credential_required']) {
        const requirement = parseCredentialRequirement(
          result['credential_required'],
          plan.action.parameters['userId'],
          plan.action.actionType,
        );
        if (!requirement) throw new Error('openclaw_response_invalid');
        if (this.onCredentialNeeded) {
          try {
            await this.onCredentialNeeded(requirement);
          } catch {
            // Don't let callback errors block the response
          }

        }
        return this.recordExecutionResult({
          planId: plan.id,
          status: 'failed',
          startedAt,
          completedAt: new Date(),
          error: 'openclaw_credentials_required',
          output: {
            adapter_used: 'openclaw',
            credential_required: true,
            integration: plan.action.actionType,
          },
        });
      }

      const status = result['status'];
      const success = result['success'];
      if (
        status !== undefined && success !== undefined &&
        ((status === 'completed') !== (success === true))
      ) {
        throw new Error('openclaw_response_invalid');
      }
      if (status === 'failed' || success === false) {
        return this.recordExecutionResult({
          planId: plan.id,
          status: 'failed',
          startedAt,
          completedAt: new Date(),
          error: 'openclaw_execution_failed',
        });
      }
      const statusValid = status === undefined || status === 'completed';
      const successValid = success === undefined || success === true;
      if (!statusValid || !successValid || (status === undefined && success === undefined)) {
        throw new Error('openclaw_response_invalid');
      }

      return this.recordExecutionResult({
        planId: plan.id,
        status: 'completed',
        startedAt,
        completedAt: new Date(),
        output: {
          adapter_used: 'openclaw',
          stepsCompleted: plan.steps.length,
          actionType: plan.action.actionType,
          description: plan.action.description,
        },
      });
    }

    // No server configured — fail explicitly (never silently succeed)
    throw new Error('openclaw_not_configured');
  }

  async getStatus(planId: string): Promise<ExecutionStatus> {
    if (this.apiUrl) {
      try {
        const response = await fetch(`${this.apiUrl}/status/${encodeURIComponent(planId)}`, {
          method: 'GET',
          headers: {
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          const payload = await response.json() as Record<string, unknown>;
          const rawStatus = payload['status'];
          if (
            rawStatus === 'pending' ||
            rawStatus === 'running' ||
            rawStatus === 'completed' ||
            rawStatus === 'failed'
          ) {
            return rawStatus;
          }
        }
      } catch {
        // Fall back to local cache below.
      }
    }

    const cached = this.executionResults.get(planId);
    if (cached) return cached.status;
    throw new Error(`No execution result found for plan ID: ${planId}`);
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
      } catch {
        return {
          success: false,
          message: 'openclaw_rollback_failed',
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

  private recordExecutionResult(result: ExecutionResult): ExecutionResult {
    this.executionResults.set(result.planId, result);
    return result;
  }
}
