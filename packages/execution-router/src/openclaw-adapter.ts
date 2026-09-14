import type {
  CandidateAction,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStatus,
  ExecutionStep,
  RollbackResult,
} from '@skytwin/shared-types';
import { OPENCLAW_ACTION_TYPES } from '@skytwin/shared-types';
import { PreRequestExecutionError, type IronClawAdapter } from '@skytwin/ironclaw-adapter';

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
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function isBoundedText(value: unknown, maxLength: number, required = true): value is string {
  return typeof value === 'string' && value.length <= maxLength && SAFE_TEXT.test(value)
    && (!required || value.trim().length > 0);
}

function parseCredentialRequirement(
  value: unknown,
  owningUserId: unknown,
  actionType: string,
): OpenClawCredentialRequirement | null {
  if (!isPlainRecord(value) ||
      !isBoundedText(owningUserId, 128) ||
      !SAFE_USER_ID.test(owningUserId)) {
    return null;
  }
  // Identity is intentionally absent: the peer cannot choose the notification owner.
  if (!hasOnlyKeys(value, ['integration', 'label', 'description', 'fields', 'skills'])) {
    return null;
  }

  const integration = value['integration'] ?? actionType;
  const integrationLabel = value['label'] ?? actionType;
  if (!isBoundedText(integration, 64) || !SAFE_SLUG.test(integration) ||
      !isBoundedText(integrationLabel, 80)) {
    return null;
  }
  if (value['description'] !== undefined &&
      !isBoundedText(value['description'], 500, false)) {
    return null;
  }

  const rawFields = value['fields'] ?? [];
  const rawSkills = value['skills'] ?? [actionType];
  if (!Array.isArray(rawFields) || rawFields.length > 20 ||
      !Array.isArray(rawSkills) || rawSkills.length > 50) {
    return null;
  }

  const fieldKeys = new Set<string>();
  const fields: OpenClawCredentialRequirement['fields'] = [];
  for (const candidate of rawFields) {
    if (!isPlainRecord(candidate) ||
        !hasOnlyKeys(candidate, ['key', 'label', 'placeholder', 'secret', 'optional']) ||
        !isBoundedText(candidate['key'], 64) ||
        !SAFE_SLUG.test(candidate['key']) ||
        fieldKeys.has(candidate['key']) ||
        !isBoundedText(candidate['label'], 80) ||
        (candidate['placeholder'] !== undefined &&
          !isBoundedText(candidate['placeholder'], 120, false)) ||
        (candidate['secret'] !== undefined && typeof candidate['secret'] !== 'boolean') ||
        (candidate['optional'] !== undefined && typeof candidate['optional'] !== 'boolean')) {
      return null;
    }
    fieldKeys.add(candidate['key']);
    fields.push({
      key: candidate['key'],
      label: candidate['label'],
      ...(candidate['placeholder'] !== undefined
        ? { placeholder: candidate['placeholder'] as string }
        : {}),
      // The peer describes the field but cannot downgrade how SkyTwin handles
      // its value. There is no trusted local non-secret allowlist for peer fields.
      secret: true,
      ...(candidate['optional'] !== undefined ? { optional: candidate['optional'] as boolean } : {}),
    });
  }

  const skills: string[] = [];
  for (const skill of rawSkills) {
    if (!isBoundedText(skill, 64) || !SAFE_SLUG.test(skill) || skills.includes(skill)) {
      return null;
    }
    skills.push(skill);
  }

  return {
    userId: owningUserId,
    integration,
    integrationLabel,
    ...(value['description'] !== undefined
      ? { description: value['description'] as string }
      : {}),
    fields,
    skills,
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
    if (!this.apiUrl) {
      throw new PreRequestExecutionError('OpenClaw is not configured.');
    }
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
          const responseBody = await response.text().catch(() => 'unreadable response');
          throw new Error(`OpenClaw returned ${response.status}: ${responseBody}`);
        }

        const result = await response.json() as Record<string, unknown>;
        const explicitStatus = result['status'];
        const explicitSuccess = result['success'];
        const explicitError = result['error'];
        if (explicitSuccess !== undefined && typeof explicitSuccess !== 'boolean') {
          throw new Error('OpenClaw success field is not boolean');
        }
        if (explicitError !== undefined && explicitError !== null && typeof explicitError !== 'string') {
          throw new Error('OpenClaw error field is not a string');
        }
        if (explicitStatus !== undefined && explicitStatus !== 'completed' &&
            explicitStatus !== 'failed' && explicitStatus !== 'pending' &&
            explicitStatus !== 'running') {
          throw new Error(`OpenClaw returned unknown status ${String(explicitStatus)}`);
        }
        if (explicitStatus === 'pending' || explicitStatus === 'running') {
          throw new Error(`OpenClaw returned non-terminal status ${explicitStatus}`);
        }
        if ((explicitStatus === 'completed' && explicitSuccess === false) ||
            (explicitStatus === 'failed' && explicitSuccess === true)) {
          throw new Error('OpenClaw response contained conflicting terminal fields');
        }
        if ((explicitStatus === 'completed' || explicitSuccess === true) &&
            typeof explicitError === 'string' && explicitError.length > 0) {
          throw new Error('OpenClaw success response also contained an error');
        }

        // Check if OpenClaw is reporting that this skill needs credentials
        if (result['credential_required']) {
          if (explicitStatus === 'completed' || explicitSuccess === true) {
            throw new Error('OpenClaw credential failure conflicted with success');
          }
          const credReq = parseCredentialRequirement(
            result['credential_required'],
            plan.executionOwnerId,
            plan.action.actionType,
          );
          if (!credReq) {
            throw new Error('OpenClaw credential requirement was malformed');
          }
          if (this.onCredentialNeeded) {
            try {
              await this.onCredentialNeeded(credReq);
            } catch {
              // Don't let callback errors block the explicit response
            }
          }

          return this.recordExecutionResult({
            planId: plan.id,
            status: 'failed',
            startedAt,
            completedAt: new Date(),
            error: `Credentials needed for ${credReq.integrationLabel}. Check the Setup page.`,
            output: {
              adapter_used: 'openclaw',
              credential_required: true,
              integration: credReq.integration,
            },
          });
        }

        if (explicitSuccess === false || explicitStatus === 'failed') {
          return this.recordExecutionResult({
            planId: plan.id,
            status: 'failed',
            startedAt,
            completedAt: new Date(),
            error: typeof result['error'] === 'string'
              ? result['error']
              : 'OpenClaw reported execution failure',
            output: { adapter_used: 'openclaw', ...result },
          });
        }
        if (explicitSuccess !== true && explicitStatus !== 'completed') {
          throw new Error('OpenClaw response did not contain an explicit terminal status');
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
            ...(result as Record<string, unknown>),
          },
        });
      } catch (err) {
        // Fetch rejection, timeout, response-body loss, and HTTP failure all
        // happen after dispatch. None proves that the remote effect did not
        // commit, so retain the running cache entry and surface ambiguity.
        throw new Error(
          `OpenClaw execution outcome is ambiguous: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    // No server configured — fail explicitly (never silently succeed)
    throw new Error(
      `OpenClaw not configured: set OPENCLAW_API_URL to enable. ` +
      `Cannot execute ${plan.action.actionType} (plan ${plan.id})`,
    );
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

  private recordExecutionResult(result: ExecutionResult): ExecutionResult {
    this.executionResults.set(result.planId, result);
    return result;
  }
}
