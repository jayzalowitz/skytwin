import type {
  ChatCompletionResponse,
  ChatMessage,
  CandidateAction,
  ExecutionEvent,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStatus,
  ExecutionStep,
  IronClawRoutine,
  IronClawToolManifest,
  RollbackResult,
} from '@skytwin/shared-types';
import type { IronClawCredentialInfo, IronClawEnhancedAdapter } from './ironclaw-adapter.js';
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
export class RealIronClawAdapter implements IronClawEnhancedAdapter {
  private readonly client: IronClawHttpClient;
  private readonly channelId: string;
  private readonly ownerId: string;

  /** Track thread IDs for rollback correlation (bounded to prevent unbounded growth) */
  private static readonly MAX_TRACKED_PLANS = 1000;
  private readonly planThreads = new Map<string, string>();
  private readonly planStatuses = new Map<string, ExecutionStatus>();

  private evictOldPlans(): void {
    if (this.planStatuses.size <= RealIronClawAdapter.MAX_TRACKED_PLANS) return;
    const excess = this.planStatuses.size - RealIronClawAdapter.MAX_TRACKED_PLANS;
    let removed = 0;
    for (const key of this.planStatuses.keys()) {
      if (removed >= excess) break;
      this.planStatuses.delete(key);
      this.planThreads.delete(key);
      removed++;
    }
  }

  constructor(config: IronClawClientConfig) {
    this.client = new IronClawHttpClient(config);
    this.channelId = config.defaultChannel ?? config.channelId ?? 'skytwin';
    this.ownerId = config.ownerId;
  }

  async buildPlan(action: CandidateAction): Promise<ExecutionPlan> {
    const planId = (action.parameters['executionPlanId'] as string | undefined)
      ?? `plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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
    this.evictOldPlans();
    this.planStatuses.set(plan.id, 'running');

    try {
      if (this.client.preferChatCompletions) {
        const response = await this.client.sendChatCompletion(this.buildExecutionChatMessages(plan));
        const result = this.client.parseChatExecutionResult(plan.id, response, startedAt);
        this.planStatuses.set(plan.id, result.status);
        return result;
      }

      const message = this.buildExecutionMessage(plan);
      const response = await this.client.sendMessage(message);
      if (response.thread_id) {
        this.planThreads.set(plan.id, response.thread_id);
      }

      const result = this.client.parseExecutionResult(plan.id, response, startedAt);
      this.planStatuses.set(plan.id, result.status);
      return result;
    } catch (error) {
      this.planStatuses.set(plan.id, 'failed');
      return {
        planId: plan.id,
        status: 'failed',
        startedAt,
        completedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async *executeStreaming(plan: ExecutionPlan): AsyncIterable<ExecutionEvent> {
    this.planStatuses.set(plan.id, 'running');
    yield {
      planId: plan.id,
      eventType: 'plan_started',
      timestamp: new Date(),
      payload: { adapter: 'ironclaw', steps: plan.steps.length },
    };

    try {
      const message = this.buildExecutionMessage(plan, { stream: true });
      for await (const event of this.client.sendMessageStreaming(message)) {
        if (event.eventType === 'plan_completed') this.planStatuses.set(plan.id, 'completed');
        if (event.eventType === 'plan_failed') this.planStatuses.set(plan.id, 'failed');
        yield event;
      }

      if (this.planStatuses.get(plan.id) === 'running') {
        this.planStatuses.set(plan.id, 'completed');
        yield {
          planId: plan.id,
          eventType: 'plan_completed',
          timestamp: new Date(),
          payload: { adapter: 'ironclaw' },
        };
      }
    } catch (error) {
      this.planStatuses.set(plan.id, 'failed');
      yield {
        planId: plan.id,
        eventType: 'plan_failed',
        timestamp: new Date(),
        payload: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async getStatus(planId: string): Promise<ExecutionStatus> {
    try {
      const status = await this.client.getStatus(planId);
      this.planStatuses.set(planId, status);
      return status;
    } catch (error) {
      const cached = this.planStatuses.get(planId);
      if (cached) return cached;
      throw error;
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

  registerCredential(
    name: string,
    value: string,
    opts?: { ttlSeconds?: number },
  ): Promise<{ success: boolean }> {
    return this.client.registerCredential(name, value, opts);
  }

  revokeCredential(name: string): Promise<{ success: boolean }> {
    return this.client.revokeCredential(name);
  }

  listCredentials(): Promise<IronClawCredentialInfo[]> {
    return this.client.listCredentials();
  }

  sendChatCompletion(
    messages: ChatMessage[],
    opts?: { model?: string },
  ): Promise<ChatCompletionResponse> {
    return this.client.sendChatCompletion(messages, opts);
  }

  discoverTools(): Promise<IronClawToolManifest[]> {
    return this.client.discoverTools();
  }

  createRoutine(userId: string, schedule: string, plan: ExecutionPlan): Promise<{ routineId: string }> {
    return this.client.createRoutine(userId, schedule, { ...plan } as Record<string, unknown>);
  }

  listRoutines(userId?: string): Promise<IronClawRoutine[]> {
    return this.client.listRoutines(userId);
  }

  deleteRoutine(routineId: string): Promise<{ success: boolean }> {
    return this.client.deleteRoutine(routineId);
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
  private buildExecutionMessage(plan: ExecutionPlan, opts: { stream?: boolean } = {}): IronClawMessage {
    const action = plan.action;
    const userId = (action.parameters['userId'] as string | undefined) ?? 'skytwin-system';
    const channel = (action.parameters['ironclawChannel'] as string | undefined) ?? this.channelId;

    // Build human-readable instruction for IronClaw's agent
    const content = this.buildInstructionContent(action);

    // Build structured metadata for precise tool dispatch
    const metadata: Record<string, unknown> = {
      skytwin: true,
      message_type: 'execute',
      plan_id: plan.id,
      decision_id: plan.decisionId,
      idempotency_key: plan.id,
      stream: opts.stream ?? false,
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
      channel,
      user_id: userId,
      owner_id: this.ownerId,
      content,
      thread_id: plan.id,
      attachments: [],
      metadata,
    };
  }

  private buildExecutionChatMessages(plan: ExecutionPlan): ChatMessage[] {
    return [
      {
        role: 'system',
        content: [
          'You are IronClaw executing a SkyTwin-approved plan.',
          'Execute only the requested action and return concise structured status.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          planId: plan.id,
          decisionId: plan.decisionId,
          action: {
            type: plan.action.actionType,
            domain: plan.action.domain,
            description: plan.action.description,
            parameters: this.sanitizeParameters(plan.action.parameters),
            reversible: plan.action.reversible,
          },
          steps: plan.steps.map((step) => ({
            id: step.id,
            order: step.order,
            type: step.type,
            description: step.description,
            parameters: this.sanitizeParameters(step.parameters),
            timeout: step.timeout,
          })),
        }),
      },
    ];
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
