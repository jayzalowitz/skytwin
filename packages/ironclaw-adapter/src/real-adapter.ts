import type {
  CandidateAction,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStep,
  RollbackResult,
} from '@skytwin/shared-types';
import type { IronClawAdapter } from './ironclaw-adapter.js';
import {
  IronClawHttpClient,
  type IronClawClientConfig,
  type IronClawMessage,
} from './ironclaw-http-client.js';

/**
 * Production IronClaw adapter that communicates with an IronClaw server
 * via its HTTP webhook API.
 *
 * IronClaw (https://github.com/nearai/ironclaw/) is a Rust-based autonomous
 * agent server. SkyTwin sends structured execution requests to IronClaw's
 * webhook endpoint, and IronClaw uses its sandboxed tool system to execute
 * the actions against external services (Gmail, Calendar, etc.).
 *
 * Authentication uses HMAC-SHA256 signing of the request body.
 *
 * This adapter:
 * - Translates SkyTwin's CandidateAction/ExecutionPlan into IronClaw messages
 * - Sends execution requests via POST /webhook with HMAC-SHA256 auth
 * - Parses IronClaw's responses back into SkyTwin's ExecutionResult types
 * - Handles retries, timeouts, and circuit breaker protection
 * - Routes rollback requests through IronClaw (same webhook, different message)
 * - Uses IronClaw's /health endpoint for health checks
 */
export class RealIronClawAdapter implements IronClawAdapter {
  private readonly client: IronClawHttpClient;
  private readonly channelId: string;
  private readonly ownerId: string;

  /** Track thread IDs for rollback correlation */
  private readonly planThreads = new Map<string, string>();

  constructor(config: IronClawClientConfig) {
    this.client = new IronClawHttpClient(config);
    this.channelId = config.channelId ?? 'skytwin';
    this.ownerId = config.ownerId;
  }

  async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
    const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date();

    // Build execution steps — IronClaw handles the actual tool orchestration,
    // but we still structure the plan for SkyTwin's persistence and audit layer.
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
      },
      timeout: 30_000,
    };

    const rollbackSteps: ExecutionStep[] = action.reversible
      ? [
          {
            id: `step_${planId}_rollback_1`,
            order: 1,
            type: `rollback_${action.actionType}`,
            description: `Rollback: ${action.description}`,
            parameters: { ...action.parameters, originalActionType: action.actionType },
            timeout: 30_000,
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
    const startedAt = new Date();

    // Build the IronClaw message from the execution plan
    const message = this.buildExecutionMessage(plan);

    try {
      const response = await this.client.sendMessage(message);

      // Track the thread ID for potential rollback
      if (response.thread_id) {
        this.planThreads.set(plan.id, response.thread_id);
      }

      return this.client.parseExecutionResult(plan.id, response, startedAt);
    } catch (error) {
      return {
        planId: plan.id,
        status: 'failed',
        startedAt,
        completedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async rollback(planId: string): Promise<RollbackResult> {
    const threadId = this.planThreads.get(planId);

    const message: IronClawMessage = {
      channel: this.channelId,
      user_id: 'skytwin-system',
      owner_id: this.ownerId,
      content: `Rollback execution plan ${planId}. Undo the previously executed action in this thread.`,
      thread_id: threadId,
      attachments: [],
      metadata: {
        skytwin: true,
        message_type: 'rollback',
        plan_id: planId,
      },
    };

    try {
      const response = await this.client.sendMessage(message);
      return this.client.parseRollbackResult(response);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    return this.client.healthCheck();
  }

  /**
   * Whether the circuit breaker is currently open (too many failures).
   */
  get isCircuitOpen(): boolean {
    return this.client.isCircuitOpen;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Translate an ExecutionPlan into an IronClaw webhook message.
   *
   * The message carries both a human-readable content string (for IronClaw's
   * agent reasoning) and structured metadata (for direct tool dispatch).
   */
  private buildExecutionMessage(plan: ExecutionPlan): IronClawMessage {
    const action = plan.action;
    const userId = action.parameters['userId'] as string ?? 'skytwin-system';

    // Build human-readable instruction for IronClaw's agent
    const content = this.buildInstructionContent(action);

    // Build structured metadata for precise tool dispatch
    const metadata: Record<string, unknown> = {
      skytwin: true,
      message_type: 'execute',
      plan_id: plan.id,
      decision_id: plan.decisionId,
      idempotency_key: plan.id,
      action: {
        type: action.actionType,
        domain: action.domain,
        description: action.description,
        parameters: this.sanitizeParameters(action.parameters),
        reversible: action.reversible,
        estimated_cost_cents: action.estimatedCostCents,
      },
      steps: plan.steps.map((s) => ({
        id: s.id,
        order: s.order,
        type: s.type,
        description: s.description,
        parameters: this.sanitizeParameters(s.parameters),
        timeout: s.timeout,
      })),
    };

    return {
      channel: this.channelId,
      user_id: userId,
      owner_id: this.ownerId,
      content,
      thread_id: plan.id,
      attachments: [],
      metadata,
    };
  }

  /**
   * Build a clear, directive instruction for IronClaw.
   *
   * IronClaw is the execution layer — we tell it exactly what to do.
   * The structured metadata carries the machine-readable action spec;
   * the content provides context for IronClaw's reasoning layer.
   */
  private buildInstructionContent(action: CandidateAction): string {
    const parts = [
      `Execute the following action as instructed by SkyTwin decision engine.`,
      ``,
      `Action: ${action.actionType}`,
      `Domain: ${action.domain}`,
      `Description: ${action.description}`,
    ];

    // Add relevant parameters as context (excluding sensitive fields)
    const safeParams = this.sanitizeParameters(action.parameters);
    const paramEntries = Object.entries(safeParams);
    if (paramEntries.length > 0) {
      parts.push(``, `Parameters:`);
      for (const [key, value] of paramEntries) {
        parts.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      }
    }

    if (action.reversible) {
      parts.push(``, `This action is reversible. Track state needed for rollback.`);
    } else {
      parts.push(``, `This action is NOT reversible. Proceed with caution.`);
    }

    parts.push(
      ``,
      `Do not make additional decisions beyond what is specified. Execute exactly as described.`,
      `Return structured status in metadata: { "status": "completed"|"failed", "outputs": {...}, "error": "..." }`,
    );

    return parts.join('\n');
  }

  /**
   * Remove sensitive fields from parameters before including in messages.
   * OAuth tokens and secrets are handled by IronClaw's credential system.
   */
  private sanitizeParameters(params: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const sensitiveKeys = ['accessToken', 'refreshToken', 'apiKey', 'secret', 'password', 'token'];

    for (const [key, value] of Object.entries(params)) {
      if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()))) {
        // Pass token references, not raw values — IronClaw manages credentials
        sanitized[`${key}_ref`] = '[managed-by-ironclaw]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}
